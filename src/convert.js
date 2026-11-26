// Opening DjVu, EPUB, FB2, CBZ and images: they are converted once into a PDF next to the original
// (by page images for DjVu/CBZ/images, by Chromium page layout for EPUB/FB2), then opened as a normal PDF.
import { el, modal } from './util.js';

const { PDFDocument, PDFName, PDFHexString, PDFNumber, PDFNull, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject, setFillingRgbColor } = window.PDFLib;

export const CONVERTIBLE = /\.(djvu|djv|epub|fb2|fb2\.zip|cbz|jpe?g|png|webp|gif|bmp)$/i;
const IMAGE = /\.(jpe?g|png|webp|gif|bmp)$/i;
const base = (p) => p.split(/[\\/]/).pop();
const joinPath = (dir, rel) => dir + '/' + rel;

class Cancelled extends Error { constructor() { super('Cancelled'); } }

// ---------- progress dialog ----------
function progressDialog(title) {
  const bar = el('div', { class: 'cv-bar' }, el('div', { class: 'cv-fill' }));
  const label = el('div', { class: 'cv-label' }, 'Preparing…');
  const m = modal(title, [label, bar], [{ label: 'Cancel', value: 'cancel' }]);
  m.root.classList.add('cv-modal');
  const st = { cancelled: false, done: false, onCancel: null };
  m.done.then(() => { if (!st.done) { st.cancelled = true; if (st.onCancel) st.onCancel(); } });
  st.set = (text, frac) => {
    label.textContent = text;
    if (frac != null) bar.firstChild.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
  };
  st.check = () => { if (st.cancelled) throw new Cancelled(); };
  st.close = () => { st.done = true; m.close('done'); };
  return st;
}

// ---------- PDF helpers ----------
function rawImage(pdf, bytes, dict) {
  return pdf.context.register(pdf.context.stream(bytes, Object.assign({ Type: 'XObject', Subtype: 'Image' }, dict)));
}
function paint(page, name, w, h, pre = []) {
  page.pushOperators(pushGraphicsState(), ...pre, concatTransformationMatrix(w, 0, 0, h, 0, 0), drawObject(name), popGraphicsState());
}
function addImagePage(pdf, p) {
  const page = pdf.addPage([p.wPt, p.hPt]);
  if (p.kind === 'layers') {
    if (p.bg) paint(page, page.node.newXObject('Bg', rawImage(pdf, p.bg.bytes, { Width: p.bg.w, Height: p.bg.h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' })), p.wPt, p.hPt);
    for (const m of p.masks) {
      const mask = rawImage(pdf, m.bytes, { Width: m.w, Height: m.h, ImageMask: true, BitsPerComponent: 1, Filter: 'FlateDecode' });
      if (p.fg) {
        // foreground colours shown only through the text mask (mask sample 0 = text = painted)
        const fg = rawImage(pdf, p.fg.bytes, { Width: p.fg.w, Height: p.fg.h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode', Mask: mask });
        paint(page, page.node.newXObject('Fg', fg), p.wPt, p.hPt);
      } else {
        paint(page, page.node.newXObject('Tx', mask), p.wPt, p.hPt, [setFillingRgbColor(m.rgb[0] / 255, m.rgb[1] / 255, m.rgb[2] / 255)]);
      }
    }
    return page;
  }
  if (p.kind === 'bits') {
    const stream = pdf.context.stream(p.bytes, {
      Type: 'XObject', Subtype: 'Image', Width: p.w, Height: p.h,
      ColorSpace: 'DeviceGray', BitsPerComponent: 1, Filter: 'FlateDecode'
    });
    const ref = pdf.context.register(stream);
    const name = page.node.newXObject('Im', ref);
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(p.wPt, 0, 0, p.hPt, 0, 0), drawObject(name), popGraphicsState());
    return page;
  }
  return p.embedded ? drawEmbedded(page, p) : null;
}
function drawEmbedded(page, p) {
  page.drawImage(p.embedded, { x: 0, y: 0, width: p.wPt, height: p.hPt });
  return page;
}

// items: [{title, page (0-based or null), children}]
export function addOutline(pdf, items) {
  const pages = pdf.getPages();
  const ctx = pdf.context;
  const clean = (list) => (list || []).map(it => ({ title: String(it.title || '').trim() || '…', page: it.page, children: clean(it.children) }))
    .filter(it => (it.page != null && pages[it.page]) || it.children.length);
  const top = clean(items);
  if (!top.length) return;
  const root = ctx.obj({ Type: 'Outlines' });
  const rootRef = ctx.register(root);
  const build = (list, parentRef) => {
    const refs = list.map(() => ctx.nextRef());
    let total = 0;
    list.forEach((it, i) => {
      const d = ctx.obj({});
      d.set(PDFName.of('Title'), PDFHexString.fromText(it.title));
      d.set(PDFName.of('Parent'), parentRef);
      if (i > 0) d.set(PDFName.of('Prev'), refs[i - 1]);
      if (i < list.length - 1) d.set(PDFName.of('Next'), refs[i + 1]);
      const pg = it.page != null && pages[it.page] ? it.page : firstPage(it.children);
      if (pg != null) d.set(PDFName.of('Dest'), ctx.obj([pages[pg].ref, PDFName.of('XYZ'), PDFNull, PDFNull, PDFNull]));
      if (it.children.length) {
        const { first, last, count } = build(it.children, refs[i]);
        d.set(PDFName.of('First'), first); d.set(PDFName.of('Last'), last);
        d.set(PDFName.of('Count'), PDFNumber.of(-count)); // collapsed
      }
      ctx.assign(refs[i], d);
      total++;
    });
    return { first: refs[0], last: refs[refs.length - 1], count: total };
  };
  const firstPage = (list) => { for (const it of list) { if (it.page != null && pages[it.page]) return it.page; const p = firstPage(it.children); if (p != null) return p; } return null; };
  const { first, last, count } = build(top, rootRef);
  root.set(PDFName.of('First'), first); root.set(PDFName.of('Last'), last); root.set(PDFName.of('Count'), PDFNumber.of(count));
  pdf.catalog.set(PDFName.of('Outlines'), rootRef);
  pdf.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

function setInfo(pdf, title, author) {
  if (title) pdf.setTitle(title);
  if (author) pdf.setAuthor(author);
  pdf.setProducer('PDF-Bat'); pdf.setCreator('PDF-Bat');
}

// ---------- DjVu ----------
async function djvuToPdf(bytes, ui) {
  const nWorkers = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1));
  const workers = [];
  const mk = () => {
    const w = new Worker(new URL('./djvu-worker.js', import.meta.url), { type: 'module' });
    const pending = new Map(); let seq = 0;
    const failAll = (err) => { for (const p of pending.values()) p.rej(err); pending.clear(); };
    w.onmessage = (e) => { const p = pending.get(e.data.id); if (!p) return; pending.delete(e.data.id); e.data.error ? p.rej(new Error(e.data.error)) : p.res(e.data); };
    w.onerror = (e) => failAll(new Error(e.message || 'DjVu decoder failed'));
    const call = (msg, transfer) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { res, rej }); w.postMessage({ ...msg, id }, transfer || []); });
    const o = { w, call, failAll };
    workers.push(o);
    return o;
  };
  ui.onCancel = () => workers.forEach(o => { o.w.terminate(); o.failAll(new Cancelled()); });
  try {
    const copy = () => bytes.slice().buffer;
    const first = mk();
    const info = await first.call({ cmd: 'open', buffer: copy() });
    const n = info.n;
    for (let k = 1; k < Math.min(nWorkers, n); k++) { const o = mk(); await o.call({ cmd: 'open', buffer: copy() }); }
    ui.check();
    // page i goes to worker i mod W; every worker decodes its pages in order
    const jobs = [];
    for (let i = 0; i < n; i++) jobs.push(workers[i % workers.length].call({ cmd: 'page', n: i, maxDpi: 225, quality: 0.82 }));
    const pdf = await PDFDocument.create();
    for (let i = 0; i < n; i++) {
      let r;
      try { r = (await jobs[i]).page; } catch (e) {
        if (e instanceof Cancelled) throw e;
        console.warn('DjVu page', i + 1, e);
        r = null;
      }
      ui.check();
      if (!r) { pdf.addPage([612, 792]); continue; } // keep numbering even if one page cannot be decoded
      if (r.kind === 'jpeg') r.embedded = await pdf.embedJpg(r.bytes);
      addImagePage(pdf, r);
      ui.set(`Page ${i + 1} of ${n}`, (i + 1) / n);
    }
    if (info.contents) addOutline(pdf, info.contents);
    ui.set('Saving…', 1);
    return pdf.save({ useObjectStreams: true });
  } finally {
    workers.forEach(o => o.w.terminate());
  }
}

// ---------- images & CBZ ----------
const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

async function embedImage(pdf, bytes, name) {
  const isJpg = /\.jpe?g$/i.test(name) || (bytes[0] === 0xff && bytes[1] === 0xd8);
  const isPng = /\.png$/i.test(name) || (bytes[0] === 0x89 && bytes[1] === 0x50);
  try {
    if (isJpg) return await pdf.embedJpg(bytes);
    if (isPng) return await pdf.embedPng(bytes);
  } catch (e) { /* fall through to the canvas path */ }
  // WebP, GIF, BMP or anything unusual: decode in Chromium, re-encode as high-quality JPEG
  const bmp = await createImageBitmap(new Blob([bytes]));
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  return pdf.embedJpg(new Uint8Array(await blob.arrayBuffer()));
}

async function imagesToPdf(items, ui) {
  // items: [{name, get: () => Promise<Uint8Array>}]
  const pdf = await PDFDocument.create();
  for (let i = 0; i < items.length; i++) {
    ui.check();
    const it = items[i];
    try {
      const img = await embedImage(pdf, await it.get(), it.name);
      // longer side = 842 pt (A4), so all pages show at a similar size
      const s = 842 / Math.max(img.width, img.height);
      drawEmbedded(pdf.addPage([img.width * s, img.height * s]), { embedded: img, wPt: img.width * s, hPt: img.height * s });
    } catch (e) { console.warn('image', it.name, e); }
    ui.set(`Image ${i + 1} of ${items.length}`, (i + 1) / items.length);
  }
  if (!pdf.getPageCount()) throw new Error('No readable images');
  return pdf.save({ useObjectStreams: true });
}

async function cbzToPdf(src, ui) {
  const names = (await window.bat.zipList(src)).filter(n => IMAGE.test(n) && !/(^|\/)(__MACOSX|\.)/.test(n)).sort(natural.compare);
  if (!names.length) throw new Error('No images inside');
  return imagesToPdf(names.map(n => ({ name: n, get: async () => new Uint8Array(await window.bat.zipFile(src, n)) })), ui);
}

// ---------- HTML-based books (EPUB, FB2) ----------
async function printAndMerge(dir, files, ui, pageSize) {
  const off = window.bat.onConvertProgress((i, n) => ui.set(`Laying out ${i} of ${n}`, i / n * 0.9));
  let parts;
  try { parts = await window.bat.printHtml(dir, files, { pageSize }); } finally { off(); }
  ui.check();
  ui.set('Joining pages…', 0.95);
  const pdf = await PDFDocument.create();
  const starts = [];
  for (const bytes of parts) {
    starts.push(pdf.getPageCount());
    const part = await PDFDocument.load(bytes);
    const pages = await pdf.copyPages(part, part.getPageIndices());
    pages.forEach(p => pdf.addPage(p));
  }
  return { pdf, starts };
}

const xml = (text) => {
  const d = new DOMParser().parseFromString(text, 'application/xml');
  if (d.getElementsByTagName('parsererror').length) {
    // be lenient: try again as HTML
    return new DOMParser().parseFromString(text, 'text/html');
  }
  return d;
};
const byLocal = (node, name) => Array.from(node.getElementsByTagName('*')).filter(n => n.localName === name);
const resolveRel = (baseRel, href) => {
  const parts = baseRel.split('/'); parts.pop();
  for (const seg of decodeURIComponent(href).split('/')) {
    if (seg === '..') parts.pop(); else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
};

async function epubToPdf(src, ui, pageSize) {
  ui.set('Unpacking…', 0.02);
  const { dir, files } = await window.bat.zipExtract(src);
  try {
    const has = new Set(files);
    if (has.has('META-INF/rights.xml')) throw new Error('This EPUB is DRM-protected');
    const read = (rel) => window.bat.readText(joinPath(dir, rel));
    const container = xml(await read('META-INF/container.xml'));
    const rootfile = byLocal(container, 'rootfile')[0];
    const opfRel = rootfile && rootfile.getAttribute('full-path');
    if (!opfRel || !has.has(opfRel)) throw new Error('Broken EPUB (no package file)');
    const opf = xml(await read(opfRel));
    const manifest = new Map();
    for (const it of byLocal(opf, 'item')) {
      manifest.set(it.getAttribute('id'), { href: resolveRel(opfRel, it.getAttribute('href') || ''), type: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || '' });
    }
    const spineEl = byLocal(opf, 'spine')[0];
    const spine = byLocal(opf, 'itemref').map(r => manifest.get(r.getAttribute('idref'))).filter(Boolean)
      .map(m => m.href).filter(h => has.has(h) && /\.(x?html?|xml|svg)$/i.test(h));
    if (!spine.length) throw new Error('This EPUB has no readable pages');
    const title = (byLocal(opf, 'title')[0] || {}).textContent;
    const author = (byLocal(opf, 'creator')[0] || {}).textContent;

    // table of contents: EPUB 3 nav, else EPUB 2 NCX
    let toc = [];
    try {
      const nav = [...manifest.values()].find(m => /\bnav\b/.test(m.props));
      if (nav && has.has(nav.href)) {
        const d = xml(await read(nav.href));
        const navEl = byLocal(d, 'nav').find(n => (n.getAttribute('epub:type') || n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') || '').includes('toc')) || byLocal(d, 'nav')[0];
        const walk = (ol) => Array.from(ol ? ol.children : []).filter(li => li.localName === 'li').map(li => {
          const a = Array.from(li.children).find(c => c.localName === 'a' || c.localName === 'span');
          const sub = Array.from(li.children).find(c => c.localName === 'ol');
          const href = a && a.getAttribute('href');
          return { title: a ? a.textContent.replace(/\s+/g, ' ') : '', file: href ? resolveRel(nav.href, href.split('#')[0]) : null, children: walk(sub) };
        });
        if (navEl) toc = walk(Array.from(navEl.children).find(c => c.localName === 'ol'));
      }
      if (!toc.length) {
        const ncxId = spineEl && spineEl.getAttribute('toc');
        const ncx = (ncxId && manifest.get(ncxId)) || [...manifest.values()].find(m => /ncx/.test(m.type));
        if (ncx && has.has(ncx.href)) {
          const d = xml(await read(ncx.href));
          const walk = (parent) => Array.from(parent.children).filter(c => c.localName === 'navPoint').map(np => {
            const label = byLocal(np, 'text')[0];
            const content = Array.from(np.children).find(c => c.localName === 'content');
            const href = content && content.getAttribute('src');
            return { title: label ? label.textContent.replace(/\s+/g, ' ') : '', file: href ? resolveRel(ncx.href, href.split('#')[0]) : null, children: walk(np) };
          });
          const map = byLocal(d, 'navMap')[0];
          if (map) toc = walk(map);
        }
      }
    } catch (e) { console.warn('EPUB contents', e); toc = []; }

    ui.check();
    const { pdf, starts } = await printAndMerge(dir, spine, ui, pageSize);
    const idx = new Map(spine.map((f, i) => [f, i]));
    const mapToc = (list) => list.map(t => ({ title: t.title, page: t.file != null && idx.has(t.file) ? starts[idx.get(t.file)] : null, children: mapToc(t.children) }));
    addOutline(pdf, mapToc(toc));
    setInfo(pdf, title, author);
    ui.set('Saving…', 1);
    return pdf.save({ useObjectStreams: true });
  } finally {
    window.bat.cleanupTmp(dir);
  }
}

// FictionBook 2 → one HTML file per top-level section, then the same print path as EPUB
function decodeXmlBytes(bytes) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
  const m = head.match(/encoding\s*=\s*["']([^"']+)["']/i);
  let enc = m ? m[1].toLowerCase() : 'utf-8';
  try { return new TextDecoder(enc).decode(bytes); } catch (e) { return new TextDecoder('utf-8').decode(bytes); }
}
const escHtml = (s) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fb2ToHtmlFiles(text) {
  const d = new DOMParser().parseFromString(text, 'application/xml');
  if (d.getElementsByTagName('parsererror').length) throw new Error('Broken FB2 file');
  const binaries = {};
  for (const b of byLocal(d, 'binary')) {
    const id = b.getAttribute('id'); if (!id) continue;
    const ext = /png/.test(b.getAttribute('content-type') || '') ? 'png' : /gif/.test(b.getAttribute('content-type') || '') ? 'gif' : 'jpg';
    const bin = atob(b.textContent.replace(/\s+/g, ''));
    const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    binaries[id] = { name: 'img/' + id.replace(/[^\w.-]/g, '_') + '.' + ext, bytes: arr };
  }
  const href = (n) => n.getAttribute('l:href') || n.getAttribute('xlink:href') || n.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
  const img = (n) => { const b = binaries[href(n).replace(/^#/, '')]; return b ? `<p class="img"><img src="${escHtml(b.name)}"></p>` : ''; };
  const conv = (n, depth) => {
    if (n.nodeType === 3) return escHtml(n.nodeValue);
    if (n.nodeType !== 1) return '';
    const kids = () => Array.from(n.childNodes).map(c => conv(c, depth)).join('');
    switch (n.localName) {
      case 'section': return `<section>${Array.from(n.childNodes).map(c => conv(c, depth + 1)).join('')}</section>`;
      case 'title': { const h = Math.min(6, depth + 1); return `<h${h}>${Array.from(n.childNodes).filter(c => c.localName === 'p').map(p => Array.from(p.childNodes).map(c => conv(c, depth)).join('')).join('<br>') || kids()}</h${h}>`; }
      case 'subtitle': return `<h5>${kids()}</h5>`;
      case 'p': return `<p>${kids()}</p>`;
      case 'v': return `<p class="v">${kids()}</p>`;
      case 'empty-line': return '<br>';
      case 'emphasis': return `<em>${kids()}</em>`;
      case 'strong': return `<strong>${kids()}</strong>`;
      case 'strikethrough': return `<s>${kids()}</s>`;
      case 'sup': case 'sub': case 'code': return `<${n.localName}>${kids()}</${n.localName}>`;
      case 'epigraph': return `<blockquote class="epigraph">${kids()}</blockquote>`;
      case 'cite': return `<blockquote>${kids()}</blockquote>`;
      case 'text-author': return `<p class="author">${kids()}</p>`;
      case 'poem': return `<div class="poem">${kids()}</div>`;
      case 'stanza': return `<div class="stanza">${kids()}</div>`;
      case 'image': return img(n);
      case 'a': return `<span class="ref">${kids()}</span>`;
      case 'table': return `<table>${kids()}</table>`;
      case 'tr': return `<tr>${kids()}</tr>`;
      case 'td': case 'th': return `<${n.localName}>${kids()}</${n.localName}>`;
      default: return kids();
    }
  };
  const ti = byLocal(d, 'title-info')[0];
  const bookTitle = ti && byLocal(ti, 'book-title')[0] ? byLocal(ti, 'book-title')[0].textContent.trim() : '';
  const author = ti ? byLocal(ti, 'author').map(a => ['first-name', 'middle-name', 'last-name'].map(k => (byLocal(a, k)[0] || {}).textContent).filter(Boolean).join(' ')).filter(Boolean).join(', ') : '';
  const lang = ti && byLocal(ti, 'lang')[0] ? byLocal(ti, 'lang')[0].textContent.trim() : '';
  const css = `body{font-family:Georgia,"Times New Roman","DejaVu Serif",serif;line-height:1.45}
p{margin:0;text-indent:1.4em;text-align:justify}h1,h2,h3,h4,h5,h6{text-align:center;text-indent:0;margin:1.2em 0 .7em}
p.img{text-indent:0;text-align:center;margin:.6em 0}p.v{text-indent:0}.poem{margin:.8em 2em}.stanza{margin-bottom:.8em}
blockquote{margin:.8em 1.5em;font-style:italic}.author{text-align:right;font-style:italic}.title-page{text-align:center;margin-top:30%}
.title-page h1{font-size:2em}.title-page .by{font-size:1.2em;margin-top:1em;text-indent:0;text-align:center}`;
  const page = (inner) => `<!doctype html><html lang="${escHtml(lang)}"><head><meta charset="utf-8"><style>${css}</style></head><body>${inner}</body></html>`;
  const out = {}; const files = []; const toc = [];
  const add = (html, title, children) => { const name = `p${String(files.length).padStart(4, '0')}.html`; out[name] = page(html); files.push(name); if (title != null) toc.push({ title, fileIndex: files.length - 1, children: children || [] }); };
  const cover = ti && byLocal(ti, 'coverpage')[0] && byLocal(byLocal(ti, 'coverpage')[0], 'image')[0];
  if (cover) add(img(cover), null);
  if (bookTitle || author) add(`<div class="title-page"><h1>${escHtml(bookTitle)}</h1><p class="by">${escHtml(author)}</p></div>`, null);
  const bodies = byLocal(d, 'body');
  for (const body of bodies) {
    const isNotes = /notes|comments/i.test(body.getAttribute('name') || '');
    const kids = Array.from(body.childNodes);
    let preface = '';
    for (const k of kids) {
      if (k.localName === 'section') {
        const t = Array.from(k.childNodes).find(c => c.localName === 'title');
        const subs = Array.from(k.childNodes).filter(c => c.localName === 'section').map(s => { const st = Array.from(s.childNodes).find(c => c.localName === 'title'); return st ? st.textContent.replace(/\s+/g, ' ').trim() : null; }).filter(Boolean);
        if (preface) { add(preface, null); preface = ''; }
        add(conv(k, isNotes ? 1 : 0), t ? t.textContent.replace(/\s+/g, ' ').trim() : (isNotes ? 'Notes' : '…'), subs.map(s => ({ title: s, fileIndex: null, children: [] })));
      } else preface += conv(k, 0);
    }
    if (preface.trim()) add(preface, isNotes ? 'Notes' : null);
  }
  for (const b of Object.values(binaries)) out[b.name] = b.bytes;
  return { out, files, toc, title: bookTitle, author };
}

async function fb2ToPdf(src, ui, pageSize) {
  let bytes;
  if (/\.zip$/i.test(src)) {
    const name = (await window.bat.zipList(src)).find(n => /\.fb2$/i.test(n));
    if (!name) throw new Error('No .fb2 inside the ZIP');
    bytes = new Uint8Array(await window.bat.zipFile(src, name));
  } else bytes = new Uint8Array((await window.bat.readFile(src)).data);
  ui.set('Reading…', 0.03);
  const { out, files, toc, title, author } = fb2ToHtmlFiles(decodeXmlBytes(bytes));
  if (!files.length) throw new Error('This FB2 has no text');
  const dir = await window.bat.writeTmp(out);
  try {
    const { pdf, starts } = await printAndMerge(dir, files, ui, pageSize);
    // sub-sections have no own file: point them at their chapter
    addOutline(pdf, toc.map(t => ({ title: t.title, page: starts[t.fileIndex], children: [] })));
    setInfo(pdf, title, author);
    ui.set('Saving…', 1);
    return pdf.save({ useObjectStreams: true });
  } finally { window.bat.cleanupTmp(dir); }
}

// ---------- entry point ----------
async function convertOne(src, opts) {
  const t = await window.bat.convertTarget(src);
  if (t.cached) return t.out;
  const ui = progressDialog(`Converting ${base(src)} to PDF`);
  try {
    let bytes;
    if (/\.(djvu|djv)$/i.test(src)) bytes = await djvuToPdf(new Uint8Array((await window.bat.readFile(src)).data), ui);
    else if (/\.epub$/i.test(src)) bytes = await epubToPdf(src, ui, opts.pageSize);
    else if (/\.fb2(\.zip)?$/i.test(src)) bytes = await fb2ToPdf(src, ui, opts.pageSize);
    else if (/\.cbz$/i.test(src)) bytes = await cbzToPdf(src, ui);
    else if (IMAGE.test(src)) bytes = await imagesToPdf([{ name: src, get: async () => new Uint8Array((await window.bat.readFile(src)).data) }], ui);
    else throw new Error('Unsupported file type');
    ui.check();
    await window.bat.writeFile(t.out, bytes);
    await window.bat.convertRemember(src, t.out);
    return t.out;
  } finally { ui.close(); }
}

async function convertImageGroup(paths) {
  const t = await window.bat.convertTarget(paths[0]);
  // several images become one PDF named after the first; not cached (the set can change)
  const out = t.out.replace(/\.pdf$/i, ` (${paths.length} images).pdf`);
  const ui = progressDialog(`Combining ${paths.length} images into a PDF`);
  try {
    const sorted = [...paths].sort((a, b) => natural.compare(base(a), base(b)));
    const bytes = await imagesToPdf(sorted.map(p => ({ name: p, get: async () => new Uint8Array((await window.bat.readFile(p)).data) })), ui);
    ui.check();
    await window.bat.writeFile(out, bytes);
    return out;
  } finally { ui.close(); }
}

// Turns a list of paths into PDF paths (PDF and .tex pass through). Calls onError(path, err) for failures.
export async function convertPaths(paths, opts = {}, onError = () => {}) {
  const out = [];
  const images = paths.filter(p => IMAGE.test(p));
  for (const p of paths) {
    if (!CONVERTIBLE.test(p)) { out.push(p); continue; }
    if (IMAGE.test(p) && images.length > 1) continue;
    try { out.push(await convertOne(p, opts)); } catch (e) { if (!(e instanceof Cancelled)) onError(p, e); }
  }
  if (images.length > 1) {
    try { out.push(await convertImageGroup(images)); } catch (e) { if (!(e instanceof Cancelled)) onError(images[0], e); }
  }
  return out;
}
