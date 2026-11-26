// Main-process helpers for turning other book formats into PDF.
//  * a small ZIP reader (EPUB, FB2.ZIP and CBZ are ZIP files)
//  * HTML/XHTML → PDF through a hidden, sandboxed Chromium window (EPUB, FB2)
//  * where to put the converted PDF, and remembering it so a file is converted only once
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { BrowserWindow, session, app } = require('electron');
const { pathToFileURL, fileURLToPath } = require('url');

// ---------- ZIP ----------
function zipEntries(buf) {
  // End Of Central Directory: last 22..65557 bytes
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Broken ZIP directory');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nlen);
    const name = (flags & 0x800) ? rawName.toString('utf8') : rawName.toString('latin1');
    out.push({ name, method, csize, usize, local, encrypted: !!(flags & 1) });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}
function zipRead(buf, e) {
  if (e.encrypted) throw new Error('Encrypted (DRM-protected) files cannot be opened');
  const p = e.local;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error('Broken ZIP entry');
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + e.csize);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return zlib.inflateRawSync(data);
  throw new Error('Unsupported ZIP compression ' + e.method);
}

function tmpRoot() {
  const d = path.join(os.tmpdir(), 'pdfbat-convert');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Extract every entry into a fresh temporary folder. Returns {dir, files: [relative names]}.
function extractZip(src) {
  const buf = fs.readFileSync(src);
  const dir = fs.mkdtempSync(path.join(tmpRoot(), 'z-'));
  const files = [];
  for (const e of zipEntries(buf)) {
    if (e.name.endsWith('/')) continue;
    const rel = e.name.replace(/\\/g, '/');
    const dest = path.resolve(dir, rel);
    if (!dest.startsWith(dir + path.sep)) continue; // no "../" escapes
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, zipRead(buf, e));
    files.push(rel);
  }
  return { dir, files };
}

// ---------- HTML → PDF ----------
const PAGE_SIZES = { A4: { width: 8.27, height: 11.69 }, A5: { width: 5.83, height: 8.27 }, Ebook: { width: 4.5, height: 6.6 } };
const PRINT_CSS = `
@page { margin: 0 }
html { -webkit-print-color-adjust: exact; }
body { font-family: Georgia, "Times New Roman", "DejaVu Serif", "Noto Serif", serif; line-height: 1.45; hyphens: auto; overflow-wrap: break-word; }
img, svg, video, table { max-width: 100% !important; }
img, svg { height: auto; page-break-inside: avoid; break-inside: avoid; }
pre { white-space: pre-wrap; }
h1, h2, h3, h4 { break-after: avoid; page-break-after: avoid; }
`;

let convSession = null;
function getSession(allowedDir) {
  if (!convSession) {
    convSession = session.fromPartition('pdfbat-convert');
    convSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  }
  // only local files from the extracted book; no network at all
  convSession.webRequest.onBeforeRequest((d, cb) => {
    if (d.url.startsWith('data:') || d.url.startsWith('blob:')) return cb({});
    if (d.url.startsWith('file:')) {
      let f = '';
      try { f = fileURLToPath(d.url); } catch (e) { return cb({ cancel: true }); }
      return cb({ cancel: !path.resolve(f).startsWith(allowedDir + path.sep) });
    }
    cb({ cancel: true });
  });
  return convSession;
}

// Print each file (absolute paths inside `dir`) to its own PDF. Returns an array of PDF byte buffers.
async function printFiles(dir, files, opts = {}, onProgress) {
  const ses = getSession(path.resolve(dir));
  const w = new BrowserWindow({
    show: false, width: 900, height: 1200,
    webPreferences: { session: ses, javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, offscreen: false }
  });
  const size = PAGE_SIZES[opts.pageSize] || PAGE_SIZES.A5;
  const m = opts.margin != null ? opts.margin : 0.55; // inches
  const out = [];
  try {
    for (let i = 0; i < files.length; i++) {
      const f = path.resolve(files[i]);
      if (!f.startsWith(path.resolve(dir) + path.sep)) throw new Error('bad path');
      await w.loadURL(pathToFileURL(f).href).catch(() => {}); // a missing image must not stop the book
      await w.webContents.insertCSS(PRINT_CSS + (opts.css || ''));
      const pdf = await w.webContents.printToPDF({
        pageSize: size, printBackground: true, preferCSSPageSize: false,
        margins: { top: m, bottom: m, left: m, right: m },
        generateDocumentOutline: false
      });
      out.push(pdf);
      if (onProgress) onProgress(i + 1, files.length);
    }
  } finally { w.destroy(); }
  return out;
}

// ---------- where converted PDFs go ----------
const FORMATS = /\.(djvu|djv|epub|fb2|fb2\.zip|cbz|jpe?g|png|webp|gif|bmp)$/i;

function targetFor(src, store) {
  const key = path.resolve(src);
  const st = fs.statSync(src);
  store.converted = store.converted || {};
  const c = store.converted[key];
  if (c && c.mtime === st.mtimeMs && c.size === st.size && fs.existsSync(c.out)) return { out: c.out, cached: true };
  const m = src.match(/^(.*?)(\.fb2\.zip|\.[^.\\/]+)$/i);
  const base = m ? m[1] : src, ext = m ? m[2].slice(1).toUpperCase() : '';
  let dir = path.dirname(src);
  try { fs.accessSync(dir, fs.constants.W_OK); } catch (e) {
    dir = path.join(app.getPath('documents'), 'PDF-Bat converted'); fs.mkdirSync(dir, { recursive: true });
  }
  const name = path.basename(base);
  let out = path.join(dir, name + '.pdf');
  for (let i = 1; fs.existsSync(out); i++) out = path.join(dir, `${name} (${ext}${i > 1 ? ' ' + i : ''}).pdf`);
  return { out, cached: false };
}
function remember(src, out, store) {
  const st = fs.statSync(src);
  store.converted = store.converted || {};
  store.converted[path.resolve(src)] = { out, mtime: st.mtimeMs, size: st.size };
}

function cleanup(dir) {
  if (dir && path.resolve(dir).startsWith(tmpRoot() + path.sep)) fs.rmSync(dir, { recursive: true, force: true });
}

function newTmpDir() { return fs.mkdtempSync(path.join(tmpRoot(), 'h-')); }

module.exports = { zipEntries, zipRead, extractZip, printFiles, targetFor, remember, cleanup, newTmpDir, FORMATS };
