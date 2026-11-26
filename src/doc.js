// Document model shared by every pane that shows the same file.
import * as pdfjsLib from './vendor/pdfjs/pdf.mjs';
import { Emitter, debounce, uid, toast } from './util.js';
import * as io from './pdfio.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.mjs', import.meta.url).href;
export { pdfjsLib };

const CMAPS = new URL('./vendor/pdfjs/cmaps/', import.meta.url).href;
const FONTS = new URL('./vendor/pdfjs/standard_fonts/', import.meta.url).href;

const docs = new Map(); // key -> Doc

export async function loadPdfjs(bytes) {
  const task = pdfjsLib.getDocument({
    data: bytes.slice(), cMapUrl: CMAPS, cMapPacked: true, standardFontDataUrl: FONTS,
    isEvalSupported: false, enableXfa: false
  });
  return task.promise;
}

export class Doc extends Emitter {
  static async open(path) {
    const key = path;
    if (docs.has(key)) return docs.get(key);
    const p = (async () => {
      const f = await window.bat.readFile(path);
      const d = new Doc(f.path, f.name, new Uint8Array(f.data));
      await d.init();
      return d;
    })();
    docs.set(key, p);
    try { const d = await p; docs.set(key, d); return d; }
    catch (e) { docs.delete(key); throw e; }
  }
  static all() { return Array.from(docs.values()).filter(d => d instanceof Doc); }

  constructor(path, name, bytes) {
    super();
    this.path = path;
    this.key = path;
    this.name = name;
    this.bytes = bytes;           // bytes the viewer renders (managed annotations stripped)
    this.annotations = [];
    this.edits = [];              // unflattened edit-mode objects
    this.formValues = {};
    this.refs = 0;
    this.contentDirty = false;    // edit-mode changes not yet saved
    this.annoDirty = false;
    this.undoStack = [];
    this.redoStack = [];
    this.meta = {};               // app-side record: lastPage, bookmarks, zoom
    this.saving = false;
    this.autosave = debounce(() => this.saveAnnotations(), 1200);
  }

  async init() {
    const original = this.bytes;
    const [pdf, ex, meta] = await Promise.all([
      loadPdfjs(original),
      io.extractAnnotations(original).catch(e => { console.warn('annotation parse failed', e); return { annotations: [], cleanBytes: null }; }),
      window.bat.getDoc(this.key)
    ]);
    this.meta = meta || {};
    this.annotations = ex.annotations;
    if (ex.cleanBytes) {
      this.bytes = ex.cleanBytes;
      pdf.destroy();
      this.pdf = await loadPdfjs(this.bytes);
    } else {
      this.pdf = pdf;
    }
    await this.loadSizes();
  }

  async loadSizes() {
    const n = this.pdf.numPages;
    this.numPages = n;
    const sizes = new Array(n);
    const proxies = new Array(n);
    const B = 64;
    for (let i = 0; i < n; i += B) {
      const batch = [];
      for (let j = i; j < Math.min(n, i + B); j++) {
        batch.push(this.pdf.getPage(j + 1).then(pg => {
          const vp = pg.getViewport({ scale: 1 });
          sizes[j] = { w: vp.width, h: vp.height };
          proxies[j] = pg;
        }));
      }
      await Promise.all(batch);
    }
    this.sizes = sizes;
    this.proxies = proxies;
  }
  viewport(i, scale) { return this.proxies[i].getViewport({ scale }); }

  getPage(i) { return this.pdf.getPage(i + 1); }

  setMeta(patch) {
    Object.assign(this.meta, patch);
    window.bat.setDoc(this.key, patch);
  }

  // ---------- undo ----------
  snapshot() { return JSON.stringify({ a: this.annotations, e: this.edits.map(stripBinary) }); }
  pushUndo() {
    this.undoStack.push({ a: JSON.parse(JSON.stringify(this.annotations)), e: this.edits.slice() });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }
  undo() {
    const s = this.undoStack.pop();
    if (!s) return false;
    this.redoStack.push({ a: JSON.parse(JSON.stringify(this.annotations)), e: this.edits.slice() });
    this.restore(s);
    return true;
  }
  redo() {
    const s = this.redoStack.pop();
    if (!s) return false;
    this.undoStack.push({ a: JSON.parse(JSON.stringify(this.annotations)), e: this.edits.slice() });
    this.restore(s);
    return true;
  }
  restore(s) {
    const annoChanged = JSON.stringify(s.a) !== JSON.stringify(this.annotations);
    this.annotations = s.a;
    this.edits = s.e;
    if (annoChanged) this.touchAnno();
    this.emit('annotations', null);
    this.emit('edits', null);
  }

  // ---------- annotations ----------
  addAnnotation(a) {
    this.pushUndo();
    a.id ||= uid();
    a.created ||= Date.now();
    this.annotations.push(a);
    this.touchAnno();
    this.emit('annotations', a.page);
    return a;
  }
  updateAnnotation(id, patch, undoable = true) {
    const a = this.annotations.find(x => x.id === id);
    if (!a) return;
    if (undoable) this.pushUndo();
    Object.assign(a, patch);
    this.touchAnno();
    this.emit('annotations', a.page);
  }
  removeAnnotation(id) {
    const i = this.annotations.findIndex(x => x.id === id);
    if (i < 0) return;
    this.pushUndo();
    const [a] = this.annotations.splice(i, 1);
    this.touchAnno();
    this.emit('annotations', a.page);
  }
  touchAnno() {
    this.annoDirty = true;
    this.emit('dirty');
    if (!this.contentDirty && window.__settings?.autosave !== false) this.autosave();
  }

  async saveAnnotations() {
    if (this.contentDirty) return; // will be written together with the content on explicit Save
    if (!this.annoDirty) return;
    if (this.saving) { this.autosave(); return; }
    this.saving = true;
    try {
      const out = await io.writeAnnotations(this.bytes, this.annotations);
      await window.bat.writeFile(this.path, out);
      this.annoDirty = false;
      this.emit('dirty');
    } catch (e) {
      console.error(e);
      toast('Could not save annotations: ' + e.message, 5000);
    } finally { this.saving = false; }
  }

  // ---------- edit-mode objects ----------
  addEdit(e) {
    this.pushUndo();
    e.id ||= uid();
    this.edits = this.edits.concat([e]);
    this.markContent();
    this.emit('edits', e.page);
    return e;
  }
  updateEdit(id, patch, undoable = false) {
    if (undoable) this.pushUndo();
    this.edits = this.edits.map(x => (x.id === id ? Object.assign({}, x, patch) : x));
    this.markContent();
    const e = this.edits.find(x => x.id === id);
    this.emit('edits', e ? e.page : null);
  }
  removeEdit(id) {
    const e = this.edits.find(x => x.id === id);
    if (!e) return;
    this.pushUndo();
    this.edits = this.edits.filter(x => x.id !== id);
    this.markContent();
    this.emit('edits', e.page);
  }
  markContent() {
    this.contentDirty = true;
    this.autosave.cancel();
    this.emit('dirty');
  }
  get dirty() { return this.contentDirty || this.annoDirty; }

  // Replace the underlying bytes (after a page operation). map: old page index -> new index | -1
  async replaceBytes(bytes, map) {
    this.bytes = bytes;
    const old = this.pdf;
    this.pdf = await loadPdfjs(bytes);
    await this.loadSizes();
    if (map) {
      this.annotations = this.annotations.filter(a => map[a.page] >= 0).map(a => Object.assign(a, { page: map[a.page] }));
      this.edits = this.edits.filter(e => map[e.page] >= 0).map(e => Object.assign({}, e, { page: map[e.page] }));
      const bm = (this.meta.bookmarks || []).filter(b => map[b.page] >= 0).map(b => Object.assign(b, { page: map[b.page] }));
      this.setMeta({ bookmarks: bm });
    }
    this.undoStack = [];
    this.redoStack = [];
    this.markContent();
    this.emit('reload');
    setTimeout(() => old.destroy(), 1000);
  }

  // Replace the whole document with fresh bytes from disk (LaTeX preview recompiles)
  async reloadBytes(bytes) {
    const ex = await io.extractAnnotations(bytes).catch(() => ({ annotations: [], cleanBytes: null }));
    this.bytes = ex.cleanBytes || bytes;
    this.annotations = ex.annotations;
    this.edits = [];
    const old = this.pdf;
    this.pdf = await loadPdfjs(this.bytes);
    await this.loadSizes();
    this.contentDirty = false; this.annoDirty = false;
    this.undoStack = []; this.redoStack = [];
    this.emit('reload');
    this.emit('dirty');
    setTimeout(() => old.destroy(), 1000);
  }

  // Explicit save: flatten edit objects, fill forms, write annotations into the PDF.
  async save(targetPath) {
    let base = this.bytes;
    if (this.edits.length || Object.keys(this.formValues).length) {
      base = await io.applyEdits(base, this.edits, this.formValues);
    }
    const out = await io.writeAnnotations(base, this.annotations);
    const dest = targetPath || this.path;
    await window.bat.writeFile(dest, out);
    if (dest !== this.path) {
      docs.delete(this.key);
      this.path = dest;
      this.key = dest;
      this.name = dest.split(/[\\/]/).pop();
      docs.set(this.key, this);
      window.bat.setDoc(this.key, this.meta);
    }
    if (base !== this.bytes) {
      this.edits = [];
      this.formValues = {};
      this.bytes = base;
      const old = this.pdf;
      this.pdf = await loadPdfjs(base);
      await this.loadSizes();
      this.emit('reload');
      setTimeout(() => old.destroy(), 1000);
    }
    this.contentDirty = false;
    this.annoDirty = false;
    this.undoStack = [];
    this.redoStack = [];
    this.emit('dirty');
    this.emit('edits', null);
  }

  // Bytes of the document with annotations, for "Save a copy" / extracting
  async exportBytes() {
    let base = this.bytes;
    if (this.edits.length || Object.keys(this.formValues).length) base = await io.applyEdits(base, this.edits, this.formValues);
    return io.writeAnnotations(base, this.annotations);
  }

  release() {
    this.refs--;
    if (this.refs <= 0) {
      if (this.annoDirty && !this.contentDirty) this.autosave.flush();
      docs.delete(this.key);
      setTimeout(() => this.pdf && this.pdf.destroy(), 3000);
    }
  }
}

function stripBinary(e) { const c = Object.assign({}, e); delete c.pdf; delete c.data; delete c.png; return c; }

// ---------- text helpers used by outline / search ----------
const textCache = new WeakMap();
export async function pageText(doc, i) {
  let m = textCache.get(doc.pdf);
  if (!m) { m = new Map(); textCache.set(doc.pdf, m); }
  if (m.has(i)) return m.get(i);
  const p = doc.getPage(i).then(pg => pg.getTextContent()).catch(() => ({ items: [], styles: {} }));
  m.set(i, p);
  return p;
}
