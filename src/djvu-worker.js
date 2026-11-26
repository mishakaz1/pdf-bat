// SPDX-License-Identifier: GPL-2.0 (uses the DjVu.js library in ./djvujs, which is GPL v2)
// Web Worker: decodes DjVu pages (DjVu.js, GPL v2, in ./djvujs) and encodes them as PDF-ready images,
// so the window stays responsive while a book is converted.
import DjVuDocument from './djvujs/DjVuDocument.js';

let doc = null;

async function deflate(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate')); // zlib = PDF FlateDecode
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// Bitonal page → 1-bit grey, Flate-compressed (sharp text, small file)
// Also used for the text mask of colour pages (0 = text, 1 = paper).
async function encodeBitonal(img) {
  const { width: w, height: h, data } = img;
  const rowBytes = (w + 7) >> 3;
  const bits = new Uint8Array(rowBytes * h);
  for (let y = 0; y < h; y++) {
    let o = y * rowBytes, src = y * w * 4;
    for (let x = 0; x < w; x += 8) {
      let b = 0;
      for (let k = 0; k < 8; k++) {
        const xx = x + k;
        // 1 = white, 0 = black (DeviceGray)
        const white = xx >= w || data[src + xx * 4] > 127; // red channel: the mask marks text with R = 0
        b = (b << 1) | (white ? 1 : 0);
      }
      bits[o++] = b;
    }
  }
  return { kind: 'bits', w, h, bytes: await deflate(bits) };
}

// Photo / colour / grey page → JPEG, downscaled to at most `maxDpi`
async function encodeJpeg(img, dpi, maxDpi, quality) {
  let { width: w, height: h } = img;
  const c0 = new OffscreenCanvas(w, h);
  c0.getContext('2d').putImageData(img, 0, 0);
  let c = c0;
  if (dpi > maxDpi) {
    const s = maxDpi / dpi;
    const W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
    c = new OffscreenCanvas(W, H);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(c0, 0, 0, W, H);
    w = W; h = H;
  }
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality });
  return { kind: 'jpeg', w, h, bytes: new Uint8Array(await blob.arrayBuffer()) };
}

async function jpegOf(img, quality) {
  const c = new OffscreenCanvas(img.width, img.height);
  c.getContext('2d').putImageData(img, 0, 0);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality });
  return { w: img.width, h: img.height, bytes: new Uint8Array(await blob.arrayBuffer()) };
}

// Pack the pixels for which `isInk(i)` holds into a 1-bit mask (0 = ink), Flate-compressed.
async function packMask(w, h, isInk) {
  const rowBytes = (w + 7) >> 3;
  const bits = new Uint8Array(rowBytes * h).fill(255);
  for (let y = 0; y < h; y++) {
    const row = y * rowBytes, base = y * w;
    for (let x = 0; x < w; x++) if (isInk(base + x)) bits[row + (x >> 3)] &= ~(0x80 >> (x & 7));
  }
  return { w, h, bytes: await deflate(bits) };
}

// Colour page with a text mask: keep DjVu's layers, like the original file does.
// Background (usually low resolution) → JPEG; text → full-resolution 1-bit masks painted with the
// foreground colours (a small JPEG, a few palette colours, or plain black). Text stays sharp, the file small.
async function encodeLayers(page) {
  const bg = page.bgimage ? await jpegOf(page.bgimage.getImage(), 0.85) : null;
  if (page.fgbz) {
    const img = page.sjbz.getImage(page.fgbz, true); // text pixels: palette colour with alpha 0; paper: opaque white
    const d = new Uint32Array(img.data.buffer);
    const colors = new Map();
    for (let i = 0; i < d.length; i++) {
      if (d[i] >>> 24) continue;
      const c = d[i] & 0xffffff;
      if (!colors.has(c)) { if (colors.size >= 12) return null; colors.set(c, true); }
    }
    const masks = [];
    for (const c of colors.keys()) {
      const m = await packMask(img.width, img.height, (i) => !(d[i] >>> 24) && (d[i] & 0xffffff) === c);
      m.rgb = [c & 255, (c >> 8) & 255, (c >> 16) & 255]; // ImageData is RGBA little-endian
      masks.push(m);
    }
    return { kind: 'layers', bg, masks, fg: null };
  }
  const mi = page.sjbz.getMaskImage();
  const md = mi.data;
  const mask = await packMask(mi.width, mi.height, (i) => md[i * 4] < 128);
  const fg = page.fgimage ? await jpegOf(page.fgimage.getImage(), 0.9) : null;
  mask.rgb = [0, 0, 0];
  return { kind: 'layers', bg, masks: [mask], fg };
}

// One page at a time: DjVuDocument.getPage() resets the previously requested page, so a second
// request must not start while the first is still being encoded.
let queue = Promise.resolve();
self.onmessage = (e) => { queue = queue.then(() => handle(e.data)); };

async function handle(m) {
  try {
    if (m.cmd === 'open') {
      doc = new DjVuDocument(m.buffer);
      const n = doc.getPagesQuantity();
      let contents = null;
      try {
        const toc = doc.getContents();
        const map = (items) => (items || []).map(b => ({
          title: b.description,
          page: (() => { try { const p = doc.getPageNumberByUrl(b.url); return p != null ? p - 1 : null; } catch (err) { return null; } })(),
          children: map(b.children)
        }));
        contents = toc ? map(toc) : null;
      } catch (err) { contents = null; }
      postMessage({ id: m.id, n, contents });
    } else if (m.cmd === 'page') {
      const page = await doc.getPage(m.n + 1);
      const dpi = page.getDpi() || 300;
      page.decode();
      const info = { width: page.info.width, height: page.info.height };
      const rot = page.getRotation();
      let enc;
      if (page.sjbz && rot === 0 && (page.bgimage || page.fgimage || page.fgbz)) enc = await encodeLayers(page);
      if (!enc) {
        const img = page.getImageData(true);
        // a mask alone (no colour layers) is a black-and-white page
        const bitonal = !!page.sjbz && !page.bgimage && !page.fgimage && !page.fgbz;
        enc = bitonal ? await encodeBitonal(img) : await encodeJpeg(img, dpi, m.maxDpi || 300, m.quality || 0.88);
      }
      // page size in points from the page's own size, not from a (possibly subsampled) layer
      const swap = rot === 90 || rot === 270;
      enc.wPt = (swap ? info.height : info.width) / dpi * 72;
      enc.hPt = (swap ? info.width : info.height) / dpi * 72;
      page.reset();
      const transfer = [enc.bytes, enc.bg && enc.bg.bytes, enc.fg && enc.fg.bytes, ...(enc.masks || []).map(x => x.bytes)].filter(Boolean).map(b => b.buffer);
      postMessage({ id: m.id, page: enc }, transfer);
    }
  } catch (err) {
    postMessage({ id: m.id, error: String(err && err.message || err) + (err && err.stack ? ' @ ' + err.stack.split('\n')[1] : '') });
  }
}
