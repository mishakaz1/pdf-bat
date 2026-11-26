// PDF read/write via pdf-lib: annotations stored *inside* the PDF, page operations, flattening edits.
const L = window.PDFLib;
const { PDFDocument, PDFName, PDFArray, PDFDict, PDFNumber, PDFString, PDFHexString, PDFRef, rgb, degrees, StandardFonts, BlendMode } = L;

export const MANAGED = ['Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Ink', 'Text', 'FreeText'];
const MANAGED_SET = new Set(MANAGED);

export async function loadLib(bytes) {
  return PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
}

const num = (o) => (o instanceof PDFNumber ? o.asNumber() : (o && o.asNumber ? o.asNumber() : 0));
function nums(arr) {
  if (!(arr instanceof PDFArray)) return [];
  const out = [];
  for (let i = 0; i < arr.size(); i++) out.push(num(arr.lookup(i)));
  return out;
}
function text(o) {
  if (o instanceof PDFString || o instanceof PDFHexString) {
    try { return o.decodeText(); } catch (_) { return ''; }
  }
  return '';
}
function nameOf(o) { return o instanceof PDFName ? o.decodeText() : (o ? String(o).replace(/^\//, '') : ''); }

// Read the annotation kinds PDF-Bat manages, and strip them so the viewer can draw them itself.
// Returns {annotations:[], cleanBytes: Uint8Array|null} (null = nothing to strip).
export async function extractAnnotations(bytes) {
  const doc = await loadLib(bytes);
  const ctx = doc.context;
  const out = [];
  let stripped = false;
  const pages = doc.getPages();
  pages.forEach((page, pi) => {
    const annots = page.node.Annots();
    if (!annots) return;
    const keep = [];
    const removeRefs = new Set();
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      const d = ctx.lookup(ref);
      if (!(d instanceof PDFDict)) { keep.push(ref); continue; }
      const sub = nameOf(d.get(PDFName.of('Subtype')));
      if (!MANAGED_SET.has(sub)) { keep.push(ref); continue; }
      const popup = d.get(PDFName.of('Popup'));
      if (popup instanceof PDFRef) removeRefs.add(popup.toString());
      const a = parseAnnot(d, sub, pi);
      if (a) out.push(a);
      stripped = true;
    }
    if (!stripped) return;
    const arr = ctx.obj([]);
    for (const r of keep) {
      if (r instanceof PDFRef && removeRefs.has(r.toString())) continue;
      const d = ctx.lookup(r);
      if (d instanceof PDFDict && nameOf(d.get(PDFName.of('Subtype'))) === 'Popup') {
        const parent = d.get(PDFName.of('Parent'));
        const pd = parent ? ctx.lookup(parent) : null;
        if (pd instanceof PDFDict && MANAGED_SET.has(nameOf(pd.get(PDFName.of('Subtype'))))) continue;
      }
      arr.push(r);
    }
    page.node.set(PDFName.of('Annots'), arr);
  });
  if (!stripped) return { annotations: [], cleanBytes: null };
  const cleanBytes = await doc.save({ useObjectStreams: false });
  return { annotations: out, cleanBytes };
}

function parseAnnot(d, sub, page) {
  const color = nums(d.lookup(PDFName.of('C')));
  const ca = d.lookup(PDFName.of('CA'));
  const opacity = ca ? num(ca) : 1;
  const rect = nums(d.lookup(PDFName.of('Rect')));
  const contents = text(d.lookup(PDFName.of('Contents')));
  const nm = text(d.lookup(PDFName.of('NM')));
  const id = nm && nm.startsWith('pdfbat-') ? nm.slice(7) : Math.random().toString(36).slice(2, 12);
  const created = Date.now();
  const col = color.length === 3 ? color : (color.length === 1 ? [color[0], color[0], color[0]] : [1, 0.83, 0]);
  if (sub === 'Highlight' || sub === 'Underline' || sub === 'StrikeOut' || sub === 'Squiggly') {
    const q = nums(d.lookup(PDFName.of('QuadPoints')));
    const rects = [];
    for (let i = 0; i + 7 < q.length; i += 8) {
      const xs = [q[i], q[i + 2], q[i + 4], q[i + 6]];
      const ys = [q[i + 1], q[i + 3], q[i + 5], q[i + 7]];
      rects.push([Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]);
    }
    if (!rects.length && rect.length === 4) rects.push(normRect(rect));
    const type = { Highlight: 'highlight', Underline: 'underline', StrikeOut: 'strike', Squiggly: 'underline' }[sub];
    return { id, type, page, rects, color: col, opacity: type === 'highlight' ? (opacity < 1 ? opacity : 0.4) : opacity, note: contents, created };
  }
  if (sub === 'Ink') {
    const inkList = d.lookup(PDFName.of('InkList'));
    const paths = [];
    if (inkList instanceof PDFArray) {
      for (let i = 0; i < inkList.size(); i++) {
        const n = nums(inkList.lookup(i));
        const pts = [];
        for (let j = 0; j + 1 < n.length; j += 2) pts.push([n[j], n[j + 1]]);
        if (pts.length) paths.push(pts);
      }
    }
    const bs = d.lookup(PDFName.of('BS'));
    let width = 1.5;
    if (bs instanceof PDFDict && bs.lookup(PDFName.of('W'))) width = num(bs.lookup(PDFName.of('W')));
    return { id, type: 'ink', page, paths, color: col, width, opacity, created };
  }
  if (sub === 'Text') {
    return { id, type: 'note', page, x: rect[0] || 0, y: rect[3] || 0, text: contents, color: col, created };
  }
  if (sub === 'FreeText') {
    const r = normRect(rect);
    return { id, type: 'freetext', page, rect: r, text: contents, color: col, size: 12, created };
  }
  return null;
}
const normRect = (r) => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
const f = (n) => (Math.round(n * 1000) / 1000).toString();

function bounds(rects, pad = 0) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of rects) { x1 = Math.min(x1, r[0]); y1 = Math.min(y1, r[1]); x2 = Math.max(x2, r[2]); y2 = Math.max(y2, r[3]); }
  return [x1 - pad, y1 - pad, x2 + pad, y2 + pad];
}

function apStream(ctx, bbox, content, gs) {
  const res = gs ? { ExtGState: { G0: Object.assign({ Type: 'ExtGState' }, gs) } } : {};
  const s = ctx.stream(content, { Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: bbox, Resources: res });
  return ctx.register(s);
}

// Write annotations into a copy of cleanBytes. Returns new bytes.
export async function writeAnnotations(cleanBytes, annotations, extraDoc) {
  const doc = extraDoc || await loadLib(cleanBytes);
  const ctx = doc.context;
  const pages = doc.getPages();
  for (const a of annotations) {
    const page = pages[a.page];
    if (!page) continue;
    const c = (a.color || [1, 0.83, 0]).slice(0, 3);
    const cs = c.map(f).join(' ');
    const base = {
      Type: 'Annot', F: 4, C: c, T: PDFHexString.fromText('PDF-Bat'),
      NM: PDFHexString.fromText('pdfbat-' + a.id), M: PDFString.fromDate(new Date(a.created || Date.now()))
    };
    let dict;
    if (a.type === 'highlight' || a.type === 'underline' || a.type === 'strike') {
      if (!a.rects || !a.rects.length) continue;
      const rect = bounds(a.rects, 1);
      const quads = [];
      let content = '';
      for (const r of a.rects) {
        quads.push(r[0], r[3], r[2], r[3], r[0], r[1], r[2], r[1]);
        const h = r[3] - r[1];
        if (a.type === 'highlight') content += `${f(r[0])} ${f(r[1])} ${f(r[2] - r[0])} ${f(h)} re f\n`;
        else {
          const y = a.type === 'underline' ? r[1] + h * 0.08 : r[1] + h * 0.45;
          content += `${f(Math.max(0.6, h * 0.07))} w ${f(r[0])} ${f(y)} m ${f(r[2])} ${f(y)} l S\n`;
        }
      }
      const op = a.type === 'highlight' ? (a.opacity ?? 0.4) : (a.opacity ?? 1);
      const ap = apStream(ctx, rect,
        a.type === 'highlight' ? `/G0 gs ${cs} rg\n${content}` : `/G0 gs ${cs} RG\n${content}`,
        a.type === 'highlight' ? { CA: op, ca: op, BM: 'Multiply' } : { CA: op, ca: op });
      const sub = { highlight: 'Highlight', underline: 'Underline', strike: 'StrikeOut' }[a.type];
      dict = Object.assign(base, { Subtype: sub, Rect: rect, QuadPoints: quads, CA: op, AP: { N: ap } });
      if (a.note) dict.Contents = PDFHexString.fromText(a.note);
    } else if (a.type === 'ink') {
      if (!a.paths || !a.paths.length) continue;
      const all = a.paths.flat().map(p => [p[0], p[1], p[0], p[1]]);
      const w = a.width || 1.5;
      const rect = bounds(all, w + 1);
      let content = `/G0 gs ${cs} RG ${f(w)} w 1 J 1 j\n`;
      for (const path of a.paths) {
        content += `${f(path[0][0])} ${f(path[0][1])} m\n`;
        if (path.length === 1) content += `${f(path[0][0] + 0.01)} ${f(path[0][1])} l\n`;
        for (let i = 1; i < path.length; i++) content += `${f(path[i][0])} ${f(path[i][1])} l\n`;
        content += 'S\n';
      }
      const op = a.opacity ?? 1;
      const ap = apStream(ctx, rect, content, { CA: op, ca: op });
      dict = Object.assign(base, { Subtype: 'Ink', Rect: rect, InkList: a.paths.map(p => p.flat()), BS: { W: w, S: 'S' }, CA: op, AP: { N: ap } });
    } else if (a.type === 'note') {
      dict = Object.assign(base, { Subtype: 'Text', Rect: [a.x, a.y - 20, a.x + 20, a.y], Name: 'Comment', Open: false, Contents: PDFHexString.fromText(a.text || '') });
    } else if (a.type === 'freetext') {
      const r = a.rect;
      dict = Object.assign(base, { Subtype: 'FreeText', Rect: r, Contents: PDFHexString.fromText(a.text || ''), DA: PDFString.of(`/Helv ${a.size || 12} Tf ${cs} rg`) });
    }
    if (!dict) continue;
    const ref = ctx.register(ctx.obj(dict));
    page.node.addAnnot(ref);
  }
  return doc.save({ useObjectStreams: false });
}

// ---------- page operations: each returns {bytes, map} where map[oldIndex] = newIndex | -1 ----------
export async function reorderPages(bytes, order) {
  // order: array of old indices in new order (may omit = delete). Supports {blank:[w,h]} entries.
  const src = await loadLib(bytes);
  const out = await PDFDocument.create();
  const idx = order.filter(o => typeof o === 'number');
  const copied = await out.copyPages(src, idx);
  const map = new Array(src.getPageCount()).fill(-1);
  let ci = 0;
  order.forEach((o, newI) => {
    if (typeof o === 'number') { out.addPage(copied[ci++]); map[o] = newI; }
    else out.addPage(o.blank || [595.28, 841.89]);
  });
  copyMeta(src, out);
  return { bytes: await out.save({ useObjectStreams: false }), map };
}

function copyMeta(src, out) {
  try { const t = src.getTitle(); if (t) out.setTitle(t); } catch (_) {}
  try { const a = src.getAuthor(); if (a) out.setAuthor(a); } catch (_) {}
  // keep the outline (bookmarks) if all pages survive in order is hard; we keep nothing here (outline regenerates heuristically).
}

export async function rotatePages(bytes, indices, delta) {
  const doc = await loadLib(bytes);
  for (const i of indices) {
    const p = doc.getPage(i);
    p.setRotation(degrees(((p.getRotation().angle + delta) % 360 + 360) % 360));
  }
  return doc.save({ useObjectStreams: false });
}

export async function appendPdf(bytes, otherBytes, at) {
  const doc = await loadLib(bytes);
  const other = await loadLib(otherBytes);
  const pages = await doc.copyPages(other, other.getPageIndices());
  let pos = at == null ? doc.getPageCount() : at;
  for (const p of pages) doc.insertPage(pos++, p);
  return doc.save({ useObjectStreams: false });
}

export async function extractPages(bytes, indices) {
  const src = await loadLib(bytes);
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, indices);
  pages.forEach(p => out.addPage(p));
  return out.save({ useObjectStreams: false });
}

export async function cropPages(bytes, indices, box) {
  // box: margins in points {l,r,t,b} applied to each page's crop box
  const doc = await loadLib(bytes);
  for (const i of indices) {
    const p = doc.getPage(i);
    const { x, y, width, height } = p.getCropBox();
    p.setCropBox(x + box.l, y + box.b, Math.max(20, width - box.l - box.r), Math.max(20, height - box.t - box.b));
  }
  return doc.save({ useObjectStreams: false });
}

// ---------- forms ----------
export async function listFormFields(bytes) {
  const doc = await loadLib(bytes);
  let form;
  try { form = doc.getForm(); } catch (_) { return []; }
  const pages = doc.getPages();
  const pageOf = (widget) => {
    const pref = widget.P();
    if (pref) { const i = pages.findIndex(p => p.ref === pref); if (i >= 0) return i; }
    for (let i = 0; i < pages.length; i++) {
      const an = pages[i].node.Annots();
      if (!an) continue;
      for (let k = 0; k < an.size(); k++) if (doc.context.lookup(an.get(k)) === widget.dict) return i;
    }
    return 0;
  };
  const out = [];
  for (const fld of form.getFields()) {
    const kind = fld.constructor.name.replace('PDF', '');
    const name = fld.getName();
    let value = '', options = null;
    try {
      if (kind === 'TextField') value = fld.getText() || '';
      else if (kind === 'CheckBox') value = fld.isChecked();
      else if (kind === 'Dropdown' || kind === 'OptionList') { value = (fld.getSelected() || [])[0] || ''; options = fld.getOptions(); }
      else if (kind === 'RadioGroup') { value = fld.getSelected() || ''; options = fld.getOptions(); }
    } catch (_) {}
    const widgets = fld.acroField.getWidgets().map(w => { const r = w.getRectangle(); return { page: pageOf(w), rect: [r.x, r.y, r.x + r.width, r.y + r.height] }; });
    out.push({ name, kind, value, options, widgets });
  }
  return out;
}

async function fillFormInDoc(doc, values) {
  const form = doc.getForm();
  const font = await embedUnicodeFont(doc, 'sans');
  for (const [name, v] of Object.entries(values)) {
    try {
      const fld = form.getField(name);
      const kind = fld.constructor.name.replace('PDF', '');
      if (kind === 'TextField') fld.setText(String(v));
      else if (kind === 'CheckBox') v ? fld.check() : fld.uncheck();
      else if (kind === 'Dropdown' || kind === 'OptionList' || kind === 'RadioGroup') { if (v) fld.select(String(v)); }
    } catch (e) { console.warn('form field', name, e); }
  }
  try { form.updateFieldAppearances(font); } catch (e) { console.warn(e); }
}

// ---------- flattening edit objects onto pages ----------
const fontCache = {};
async function fontBytes(kind) {
  const file = { sans: 'DejaVuSans.ttf', serif: 'DejaVuSerif.ttf', mono: 'DejaVuSansMono.ttf' }[kind] || 'DejaVuSans.ttf';
  if (!fontCache[file]) fontCache[file] = await window.bat.asset('fonts/' + file);
  return fontCache[file];
}
async function embedUnicodeFont(doc, kind) {
  doc.registerFontkit(window.fontkit);
  return doc.embedFont(await fontBytes(kind), { subset: true });
}

// edits: [{type:'text'|'image'|'whiteout'|'rect'|'latex'|'signature', page, rect:[x1,y1,x2,y2] (pdf coords), ...}]
// formValues: {name:value}
export async function applyEdits(bytes, edits, formValues) {
  const doc = await loadLib(bytes);
  const pages = doc.getPages();
  const fonts = {};
  const getFont = async (k) => (fonts[k] ||= await embedUnicodeFont(doc, k));
  // whiteouts first so that new content lands on top of them
  const sorted = edits.slice().sort((a, b) => (a.type === 'whiteout' ? 0 : 1) - (b.type === 'whiteout' ? 0 : 1));
  // covers of "edited" text go first, under everything else
  for (const e of sorted) {
    if (e.type !== 'text' || !e.cover || !pages[e.page]) continue;
    const [c1, c2, c3, c4] = e.cover;
    pages[e.page].drawRectangle({ x: c1, y: c2, width: c3 - c1, height: c4 - c2, color: rgb(...(e.coverColor || [1, 1, 1])), borderWidth: 0 });
  }
  for (const e of sorted) {
    const page = pages[e.page];
    if (!page) continue;
    const [x1, y1, x2, y2] = e.rect;
    const w = x2 - x1, h = y2 - y1;
    if (e.type === 'whiteout') {
      page.drawRectangle({ x: x1, y: y1, width: w, height: h, color: rgb(...(e.fill || [1, 1, 1])), borderWidth: 0 });
    } else if (e.type === 'rect') {
      page.drawRectangle({ x: x1, y: y1, width: w, height: h, borderColor: rgb(...(e.color || [0, 0, 0])), borderWidth: e.width || 1, color: e.fill ? rgb(...e.fill) : undefined, opacity: e.fill ? (e.fillOpacity ?? 1) : undefined });
    } else if (e.type === 'line' || e.type === 'arrow') {
      const [ax, ay, bx, by] = e.points;
      const col = rgb(...(e.color || [0, 0, 0]));
      page.drawLine({ start: { x: ax, y: ay }, end: { x: bx, y: by }, thickness: e.width || 1.2, color: col });
      if (e.type === 'arrow') {
        const ang = Math.atan2(by - ay, bx - ax), L2 = 6 + (e.width || 1.2) * 3;
        for (const s of [-1, 1]) {
          const a2 = ang + Math.PI + s * 0.45;
          page.drawLine({ start: { x: bx, y: by }, end: { x: bx + L2 * Math.cos(a2), y: by + L2 * Math.sin(a2) }, thickness: e.width || 1.2, color: col });
        }
      }
    } else if (e.type === 'text') {
      const font = await getFont(e.font || 'sans');
      const size = e.size || 12;
      const lines = String(e.text || '').split('\n');
      const lh = size * 1.2;
      lines.forEach((ln, i) => {
        if (!ln) return;
        page.drawText(ln, { x: x1, y: y2 - size * 0.95 - i * lh, size, font, color: rgb(...(e.color || [0, 0, 0])) });
      });
    } else if (e.type === 'image' || (e.type === 'signature' && e.png)) {
      const data = e.png || e.data;
      const img = e.imgType === 'jpg' ? await doc.embedJpg(data) : await doc.embedPng(data);
      page.drawImage(img, { x: x1, y: y1, width: w, height: h });
    } else if (e.type === 'latex') {
      // vector: embed page 1 of the compiled LaTeX PDF
      const src = await PDFDocument.load(e.pdf);
      const [emb] = await doc.embedPdf(src, [0]);
      page.drawPage(emb, { x: x1, y: y1, width: w, height: h });
    }
  }
  if (formValues && Object.keys(formValues).length) await fillFormInDoc(doc, formValues);
  return doc.save({ useObjectStreams: false });
}

export async function pageSizesOf(bytes) {
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return doc.getPages().map(p => p.getSize());
}

export async function newBlankPdf(w = 595.28, h = 841.89) {
  const d = await PDFDocument.create();
  d.addPage([w, h]);
  return d.save();
}
