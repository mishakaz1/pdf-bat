// Edit mode: objects placed on pages (text, images, shapes, whiteout, signature, LaTeX), editing existing text,
// page organisation and form filling. Objects stay editable until Save, then get flattened into the PDF.
import { el, modal, toast, hexToRgb, rgbToHex, clamp, uid } from './util.js';
import { pdfjsLib } from './doc.js';
import * as io from './pdfio.js';

const TOOLS = new Set(['eselect', 'text', 'edittext', 'whiteout', 'rect', 'line', 'arrow', 'image', 'signature', 'latex']);
const BOX_TOOLS = new Set(['text', 'whiteout', 'rect', 'line', 'arrow', 'image', 'signature', 'latex']);

export class Editor {
  constructor(app) {
    this.app = app;
    this.selected = null;   // {pane, id}
    this.textColor = '#111111';
    this.textSize = 12;
    this.textFont = 'sans';
    this.strokeColor = '#d9453b';
    this.strokeWidth = 1.5;
    document.addEventListener('click', (e) => this.onDocClick(e), true);
    document.addEventListener('keydown', (e) => this.onKey(e));
  }

  handlesTool(t) { return TOOLS.has(t); }
  isBoxTool(t) { return BOX_TOOLS.has(t); }

  get doc() { return this.app.active && this.app.active.doc; }

  // ---------- rendering of edit objects ----------
  renderLayer(pane, v) {
    const layer = v.editLayer;
    if (!layer || !v.vp) return;
    layer.textContent = '';
    const vp = v.vp;
    for (const e of pane.doc.edits) {
      if (e.page !== v.i) continue;
      const r = pdfjsLib.Util.normalizeRect(vp.convertToViewportRectangle(e.rect));
      const box = { left: r[0] + 'px', top: r[1] + 'px', width: (r[2] - r[0]) + 'px', height: (r[3] - r[1]) + 'px' };
      let node;
      if (e.type === 'text') {
        if (e.cover) {
          const c = pdfjsLib.Util.normalizeRect(vp.convertToViewportRectangle(e.cover));
          layer.append(el('div', { class: 'eobj whiteout', style: { left: c[0] + 'px', top: c[1] + 'px', width: (c[2] - c[0]) + 'px', height: (c[3] - c[1]) + 'px', background: rgbToHex(e.coverColor || [1, 1, 1]), pointerEvents: 'none', outline: 'none' } }));
        }
        const content = el('div', { class: 'content', style: { fontSize: (e.size * vp.scale) + 'px', color: rgbToHex(e.color), fontFamily: { sans: 'DejaVu Sans, Helvetica, Arial, sans-serif', serif: 'DejaVu Serif, Times New Roman, serif', mono: 'DejaVu Sans Mono, monospace' }[e.font || 'sans'] } }, e.text);
        node = el('div', { class: 'eobj text', style: Object.assign({}, box, { height: 'auto', minHeight: box.height }) }, content);
        node._content = content;
      } else if (e.type === 'whiteout') {
        node = el('div', { class: 'eobj whiteout', style: Object.assign({}, box, { background: rgbToHex(e.fill || [1, 1, 1]) }) });
      } else if (e.type === 'rect') {
        node = el('div', { class: 'eobj rect', style: Object.assign({}, box, { border: `${Math.max(1, (e.width || 1) * vp.scale)}px solid ${rgbToHex(e.color)}`, background: e.fill ? rgbToHex(e.fill) : 'transparent' }) });
      } else if (e.type === 'line' || e.type === 'arrow') {
        const [ax, ay] = vp.convertToViewportPoint(e.points[0], e.points[1]);
        const [bx, by] = vp.convertToViewportPoint(e.points[2], e.points[3]);
        const x0 = Math.min(ax, bx) - 10, y0 = Math.min(ay, by) - 10;
        const w = Math.abs(bx - ax) + 20, h = Math.abs(by - ay) + 20;
        const col = rgbToHex(e.color);
        const sw = Math.max(1, (e.width || 1.2) * vp.scale);
        let svg = `<svg width="${w}" height="${h}" style="position:absolute;left:0;top:0;overflow:visible"><line x1="${ax - x0}" y1="${ay - y0}" x2="${bx - x0}" y2="${by - y0}" stroke="${col}" stroke-width="${sw}" stroke-linecap="round"/>`;
        if (e.type === 'arrow') {
          const ang = Math.atan2(by - ay, bx - ax), L = (6 + (e.width || 1.2) * 3) * vp.scale;
          for (const s of [-1, 1]) {
            const a2 = ang + Math.PI + s * 0.45;
            svg += `<line x1="${bx - x0}" y1="${by - y0}" x2="${bx - x0 + L * Math.cos(a2)}" y2="${by - y0 + L * Math.sin(a2)}" stroke="${col}" stroke-width="${sw}" stroke-linecap="round"/>`;
          }
        }
        svg += '</svg>';
        node = el('div', { class: 'eobj line', style: { left: x0 + 'px', top: y0 + 'px', width: w + 'px', height: h + 'px' }, html: svg });
      } else if (e.type === 'image' || e.type === 'signature' || e.type === 'latex') {
        node = el('div', { class: 'eobj ' + e.type, style: box });
        node.append(el('img', { src: e.previewUrl || this.blobUrl(e) }));
      } else continue;
      node.dataset.id = e.id;
      if (this.selected && this.selected.id === e.id) node.classList.add('sel');
      if (e.type !== 'line' && e.type !== 'arrow') node.append(el('div', { class: 'handle' }));
      this.bindObject(pane, v, node, e);
      layer.append(node);
    }
  }

  blobUrl(e) {
    if (e._url) return e._url;
    const data = e.data || e.png;
    if (!data) return '';
    e._url = URL.createObjectURL(new Blob([data], { type: e.imgType === 'jpg' ? 'image/jpeg' : 'image/png' }));
    return e._url;
  }

  bindObject(pane, v, node, e) {
    node.addEventListener('pointerdown', (ev) => {
      if (this.app.mode !== 'edit') return;
      if (node._editing) return;
      ev.stopPropagation();
      this.select(pane, e.id);
      const resize = ev.target.classList.contains('handle');
      const vp = v.vp;
      const start = [ev.clientX, ev.clientY];
      const orig = JSON.parse(JSON.stringify({ rect: e.rect, points: e.points }));
      let moved = false;
      node.setPointerCapture(ev.pointerId);
      const move = (m) => {
        const dx = (m.clientX - start[0]) / vp.scale, dy = -(m.clientY - start[1]) / vp.scale;
        if (!moved && Math.hypot(dx, dy) < 1) return;
        if (!moved) { pane.doc.pushUndo(); moved = true; }
        const r = orig.rect.slice();
        if (resize) {
          let w = Math.max(6, r[2] - r[0] + dx);
          let h = Math.max(6, r[3] - r[1] - dy);
          if (e.type === 'image' || e.type === 'signature' || e.type === 'latex') { const ar = (orig.rect[3] - orig.rect[1]) / (orig.rect[2] - orig.rect[0]); h = w * ar; }
          const patch = { rect: [r[0], r[3] - h, r[0] + w, r[3]] };
          if (e.type === 'latex' && e.baseWidth) patch.scaleFactor = w / e.baseWidth;
          pane.doc.updateEdit(e.id, patch);
        } else {
          const patch = { rect: [r[0] + dx, r[1] + dy, r[2] + dx, r[3] + dy] };
          if (orig.points) patch.points = [orig.points[0] + dx, orig.points[1] + dy, orig.points[2] + dx, orig.points[3] + dy];
          pane.doc.updateEdit(e.id, patch);
        }
      };
      const up = () => {
        node.removeEventListener('pointermove', move);
        node.removeEventListener('pointerup', up);
      };
      node.addEventListener('pointermove', move);
      node.addEventListener('pointerup', up);
    });
    node.addEventListener('dblclick', (ev) => {
      if (this.app.mode !== 'edit') return;
      ev.stopPropagation();
      if (e.type === 'text') this.editText(pane, node, e);
      else if (e.type === 'latex') this.app.openLatexSnippet(pane, { edit: e });
    });
  }

  select(pane, id) {
    this.selected = id ? { pane, id } : null;
    document.querySelectorAll('.eobj.sel').forEach(n => n.classList.remove('sel'));
    if (id) document.querySelectorAll(`.eobj[data-id="${id}"]`).forEach(n => n.classList.add('sel'));
    this.app.updateToolbar();
  }

  selectedEdit() {
    if (!this.selected) return null;
    return this.selected.pane.doc.edits.find(x => x.id === this.selected.id) || null;
  }

  editText(pane, node, e) {
    const c = node._content;
    node._editing = true;
    c.contentEditable = 'plaintext-only';
    c.focus();
    const range = document.createRange();
    range.selectNodeContents(c);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(range);
    const finish = () => {
      c.removeEventListener('blur', finish);
      node._editing = false;
      c.contentEditable = 'false';
      const t = c.innerText.replace(/\n$/, '');
      if (!t.trim()) { pane.doc.removeEdit(e.id); return; }
      // grow the box to the measured text size
      const vp = pane.views[e.page].vp;
      const w = Math.max(node.offsetWidth, c.scrollWidth) / vp.scale;
      const h = c.scrollHeight / vp.scale;
      if (t !== e.text || Math.abs(h - (e.rect[3] - e.rect[1])) > 0.5) {
        pane.doc.updateEdit(e.id, { text: t, rect: [e.rect[0], e.rect[3] - h, e.rect[0] + Math.max(w, 10), e.rect[3]] }, true);
      }
    };
    c.addEventListener('blur', finish);
    c.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape' || (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey))) { ev.preventDefault(); c.blur(); }
    });
  }

  onKey(ev) {
    if (this.app.mode !== 'edit' || !this.selected) return;
    if (ev.target.closest && ev.target.closest('input,textarea,[contenteditable="true"],[contenteditable="plaintext-only"]')) return;
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      ev.preventDefault();
      this.selected.pane.doc.removeEdit(this.selected.id);
      this.selected = null;
      this.app.updateToolbar();
    } else if (ev.key === 'Escape') this.select(null, null);
    else if (ev.key.startsWith('Arrow')) {
      const e = this.selectedEdit();
      if (!e) return;
      ev.preventDefault();
      const d = ev.shiftKey ? 10 : 1;
      const dx = ev.key === 'ArrowLeft' ? -d : ev.key === 'ArrowRight' ? d : 0;
      const dy = ev.key === 'ArrowUp' ? d : ev.key === 'ArrowDown' ? -d : 0;
      const patch = { rect: [e.rect[0] + dx, e.rect[1] + dy, e.rect[2] + dx, e.rect[3] + dy] };
      if (e.points) patch.points = [e.points[0] + dx, e.points[1] + dy, e.points[2] + dx, e.points[3] + dy];
      this.selected.pane.doc.updateEdit(e.id, patch);
    }
  }

  onDocClick(ev) {
    if (this.app.mode !== 'edit') return;
    if (this.app.tool === 'edittext') {
      const span = ev.target.closest && ev.target.closest('.textLayer span');
      if (!span) return;
      const pageEl = span.closest('.page');
      const pane = this.app.panes.find(p => p.root.contains(pageEl));
      if (!pane) return;
      ev.preventDefault(); ev.stopPropagation();
      this.convertSpan(pane, pane.views[+pageEl.dataset.page], span);
      return;
    }
    if (this.app.tool === 'eselect' && !(ev.target.closest && ev.target.closest('.eobj,#topbar,.modal,#sidebar'))) {
      if (this.selected) this.select(null, null);
    }
  }

  // Edit existing text: cover the original span and replace it with an editable text object.
  convertSpan(pane, v, span) {
    const vp = v.vp;
    const pr = v.div.getBoundingClientRect();
    const sr = span.getBoundingClientRect();
    const x1 = sr.left - pr.left, y1 = sr.top - pr.top, x2 = sr.right - pr.left, y2 = sr.bottom - pr.top;
    const a = vp.convertToPdfPoint(x1, y1), b = vp.convertToPdfPoint(x2, y2);
    const rect = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    const cs = getComputedStyle(span);
    const size = parseFloat(cs.fontSize) / vp.scale;
    const fam = (cs.fontFamily || '').toLowerCase();
    const font = fam.includes('mono') ? 'mono' : fam.includes('serif') && !fam.includes('sans') ? 'serif' : 'sans';
    const { fg, bg } = sampleColors(v.canvas, x1, y1, x2 - x1, y2 - y1, pr.width);
    const text = span.textContent;
    const pad = size * 0.12;
    const e = pane.doc.addEdit({
      type: 'text', page: v.i, text, size: Math.round(size * 10) / 10, font, color: fg,
      rect: [rect[0], rect[1] - pad, rect[2] + size, rect[3] + pad * 0.5],
      cover: [rect[0] - pad, rect[1] - pad, rect[2] + pad, rect[3] + pad], coverColor: bg
    });
    requestAnimationFrame(() => {
      const node = v.editLayer && v.editLayer.querySelector(`.eobj[data-id="${e.id}"]`);
      if (node) { this.select(pane, e.id); this.editText(pane, node, e); }
    });
  }

  // ---------- creating objects ----------
  pointerDown(pane, v, ev, local) {
    const tool = this.app.tool;
    if (!BOX_TOOLS.has(tool)) return;
    ev.preventDefault();
    const vp = v.vp;
    const toPdf = (x, y) => vp.convertToPdfPoint(x, y);
    if (tool === 'text') {
      const [x, y] = local(ev);
      const [px, py] = toPdf(x, y);
      const e = pane.doc.addEdit({ type: 'text', page: v.i, text: 'Text', size: this.textSize, font: this.textFont, color: hexToRgb(this.textColor), rect: [px, py - this.textSize * 1.25, px + 160, py] });
      requestAnimationFrame(() => {
        const node = v.editLayer.querySelector(`.eobj[data-id="${e.id}"]`);
        if (node) { this.select(pane, e.id); this.editText(pane, node, e); }
      });
      return;
    }
    if (tool === 'image' || tool === 'signature' || tool === 'latex') {
      const [x, y] = local(ev);
      const [px, py] = toPdf(x, y);
      if (tool === 'image') this.placeImage(pane, v.i, px, py);
      else if (tool === 'signature') this.placeSignature(pane, v.i, px, py);
      else this.app.openLatexSnippet(pane, { page: v.i, x: px, y: py });
      return;
    }
    // drag tools
    if (tool === 'line' || tool === 'arrow') {
      v.inputLayer.setPointerCapture(ev.pointerId);
      const [sx, sy] = local(ev);
      const svg = el('div', { class: 'drag-rect', style: { border: 0, background: 'none', inset: 0 }, html: `<svg style="position:absolute;inset:0;width:100%;height:100%;overflow:visible"><line stroke="${this.strokeColor}" stroke-width="${this.strokeWidth * vp.scale}" x1="${sx}" y1="${sy}" x2="${sx}" y2="${sy}"/></svg>` });
      v.div.append(svg);
      const line = svg.querySelector('line');
      let end = [sx, sy];
      const move = (m) => {
        end = local(m);
        if (m.shiftKey) { // snap to 45°
          const dx = end[0] - sx, dy = end[1] - sy, a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4), L = Math.hypot(dx, dy);
          end = [sx + L * Math.cos(a), sy + L * Math.sin(a)];
        }
        line.setAttribute('x2', end[0]); line.setAttribute('y2', end[1]);
      };
      const up = () => {
        v.inputLayer.removeEventListener('pointermove', move);
        v.inputLayer.removeEventListener('pointerup', up);
        svg.remove();
        if (Math.hypot(end[0] - sx, end[1] - sy) < 3) return;
        const a = toPdf(sx, sy), b = toPdf(end[0], end[1]);
        pane.doc.addEdit({ type: tool, page: v.i, points: [a[0], a[1], b[0], b[1]], rect: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])], color: hexToRgb(this.strokeColor), width: this.strokeWidth });
      };
      v.inputLayer.addEventListener('pointermove', move);
      v.inputLayer.addEventListener('pointerup', up);
      return;
    }
    pane.dragRect(v, ev, local, (r) => {
      if (r.w < 3 || r.h < 3) return;
      const a = toPdf(r.x, r.y), b = toPdf(r.x + r.w, r.y + r.h);
      const rect = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
      if (tool === 'whiteout') {
        const { bg } = sampleColors(v.canvas, r.x, r.y, r.w, r.h, v.div.clientWidth);
        pane.doc.addEdit({ type: 'whiteout', page: v.i, rect, fill: bg });
      } else if (tool === 'rect') {
        pane.doc.addEdit({ type: 'rect', page: v.i, rect, color: hexToRgb(this.strokeColor), width: this.strokeWidth });
      }
    });
  }

  async placeImage(pane, page, px, py) {
    const img = await window.bat.openImage();
    if (!img) return;
    const data = new Uint8Array(img.data);
    const dims = await imageSize(data, img.type);
    const w = Math.min(220, dims.w * 0.75), h = w * dims.h / dims.w;
    const e = pane.doc.addEdit({ type: 'image', page, data, imgType: img.type, rect: [px, py - h, px + w, py] });
    this.select(pane, e.id);
  }

  async placeSignature(pane, page, px, py) {
    const png = await this.signatureDialog();
    if (!png) return;
    const dims = await imageSize(png, 'png');
    const w = 150, h = w * dims.h / dims.w;
    const e = pane.doc.addEdit({ type: 'signature', page, png, imgType: 'png', rect: [px, py - h, px + w, py] });
    this.select(pane, e.id);
  }

  async signatureDialog() {
    const settings = this.app.settings;
    const saved = settings.signatures || [];
    const W = 520, H = 180;
    const pad = el('canvas', { class: 'sig-pad', width: W * 2, height: H * 2, style: { width: W + 'px', height: H + 'px' } });
    const ctx = pad.getContext('2d');
    ctx.scale(2, 2); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = 2.4; ctx.strokeStyle = '#0b1f66';
    let drawing = false, empty = true, last = null;
    pad.addEventListener('pointerdown', (e) => { drawing = true; empty = false; pad.setPointerCapture(e.pointerId); last = [e.offsetX, e.offsetY]; });
    pad.addEventListener('pointermove', (e) => {
      if (!drawing) return;
      for (const c of (e.getCoalescedEvents ? e.getCoalescedEvents() : [e])) {
        ctx.beginPath(); ctx.moveTo(last[0], last[1]); ctx.lineTo(c.offsetX, c.offsetY); ctx.stroke(); last = [c.offsetX, c.offsetY];
      }
    });
    pad.addEventListener('pointerup', () => { drawing = false; });
    let chosen = null;
    const savedRow = el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' } },
      ...saved.map((url, i) => {
        const img = el('img', { src: url, style: { height: '50px', background: '#fff', border: '1px solid var(--line)', borderRadius: '6px', padding: '4px', cursor: 'pointer' }, title: 'Use this signature' });
        img.addEventListener('click', () => { chosen = url; m.close('saved'); });
        const del = el('button', { onclick: () => { saved.splice(i, 1); this.app.setSettings({ signatures: saved }); wrap.remove(); } }, '✕');
        const wrap = el('div', { style: { display: 'flex', alignItems: 'center' } }, img, del);
        return wrap;
      }));
    const colorSel = el('select', {}, el('option', { value: '#0b1f66' }, 'Blue ink'), el('option', { value: '#111111' }, 'Black ink'));
    colorSel.addEventListener('change', () => { ctx.strokeStyle = colorSel.value; });
    const m = modal('Signature', [el('div', { style: { color: 'var(--fg2)', marginBottom: '6px' } }, 'Draw your signature with the mouse or trackpad.'), pad,
      el('div', { style: { display: 'flex', gap: '6px', marginTop: '6px' } }, el('button', { onclick: () => { ctx.clearRect(0, 0, W, H); empty = true; } }, 'Clear'), colorSel),
      saved.length ? el('label', {}, 'Saved signatures') : null, savedRow], [
      { label: 'Use', primary: true, value: 'drawn' },
      { label: 'Cancel', value: null }
    ]);
    const r = await m.done;
    if (r === 'saved') return dataUrlToBytes(chosen);
    if (r !== 'drawn' || empty) return null;
    const url = trimCanvas(pad);
    if (!saved.includes(url)) { saved.unshift(url); this.app.setSettings({ signatures: saved.slice(0, 6) }); }
    return dataUrlToBytes(url);
  }

  // ---------- page operations ----------
  async pageOp(kind, pages) {
    const doc = this.doc;
    if (!doc) return;
    const n = doc.numPages;
    try {
      if (kind === 'rotate') {
        const bytes = await io.rotatePages(doc.bytes, pages, 90);
        await doc.replaceBytes(bytes, identity(n));
      } else if (kind === 'delete') {
        if (pages.length >= n) { toast('A PDF needs at least one page'); return; }
        const r = await window.bat.confirm(`Delete ${pages.length} page${pages.length > 1 ? 's' : ''}?`, 'You can still discard changes by closing without saving.', ['Delete', 'Cancel']);
        if (r !== 0) return;
        const del = new Set(pages);
        const order = []; for (let i = 0; i < n; i++) if (!del.has(i)) order.push(i);
        const { bytes, map } = await io.reorderPages(doc.bytes, order);
        this.app.sidebar.selectedPages.clear();
        await doc.replaceBytes(bytes, map);
      } else if (kind === 'blank') {
        const after = pages[pages.length - 1];
        const s = doc.sizes[after];
        const order = []; for (let i = 0; i < n; i++) { order.push(i); if (i === after) order.push({ blank: [s.w, s.h] }); }
        const { bytes, map } = await io.reorderPages(doc.bytes, order);
        await doc.replaceBytes(bytes, map);
      } else if (kind === 'insertPdf') {
        const paths = await window.bat.openDialog();
        if (!paths.length) return;
        let bytes = doc.bytes;
        const at = pages[pages.length - 1] + 1;
        let inserted = 0;
        for (const p of paths.slice().reverse()) {
          const f = await window.bat.readFile(p);
          const before = (await io.loadLib(bytes)).getPageCount();
          bytes = await io.appendPdf(bytes, new Uint8Array(f.data), at);
          inserted += (await io.loadLib(bytes)).getPageCount() - before;
        }
        const map = identity(n).map(i => (i >= at ? i + inserted : i));
        await doc.replaceBytes(bytes, map);
        toast(`Inserted ${inserted} page${inserted > 1 ? 's' : ''}`);
      } else if (kind === 'extract') {
        const full = await doc.exportBytes();
        const out = await io.extractPages(full, pages);
        const p = await window.bat.saveDialog(doc.path.replace(/\.pdf$/i, '') + ` (pages ${pages[0] + 1}${pages.length > 1 ? '-' + (pages[pages.length - 1] + 1) : ''}).pdf`);
        if (!p) return;
        await window.bat.writeFile(p, out);
        toast('Saved ' + p.split(/[\\/]/).pop());
        return;
      } else if (kind === 'crop') {
        await this.cropDialog(pages);
        return;
      }
      this.app.sidebar.refresh();
    } catch (e) {
      console.error(e);
      toast('Page operation failed: ' + e.message, 5000);
    }
  }

  async movePages(moving, to) {
    const doc = this.doc;
    const n = doc.numPages;
    const set = new Set(moving);
    const rest = []; for (let i = 0; i < n; i++) if (!set.has(i)) rest.push(i);
    const insertAt = rest.filter(i => i < to).length;
    const order = rest.slice(0, insertAt).concat(moving, rest.slice(insertAt));
    if (order.every((x, i) => x === i)) return;
    const { bytes, map } = await io.reorderPages(doc.bytes, order);
    this.app.sidebar.selectedPages = new Set(moving.map(i => map[i]));
    await doc.replaceBytes(bytes, map);
    this.app.sidebar.refresh();
  }

  async cropDialog(pages) {
    const doc = this.doc;
    const mk = (v) => el('input', { type: 'number', value: v, min: 0, step: 1, style: { width: '70px' } });
    const l = mk(10), r = mk(10), t = mk(10), b = mk(10);
    const scope = el('select', {}, el('option', { value: 'sel' }, `Selected pages (${pages.length})`), el('option', { value: 'all' }, `All pages (${doc.numPages})`));
    const m = modal('Crop margins', [
      el('div', { style: { color: 'var(--fg2)' } }, 'Trim each side by (millimetres):'),
      el('div', { style: { display: 'grid', gridTemplateColumns: 'auto auto auto auto', gap: '6px 10px', alignItems: 'center', marginTop: '8px' } },
        'Left', l, 'Right', r, 'Top', t, 'Bottom', b),
      el('label', {}, 'Apply to'), scope
    ], [{ label: 'Crop', primary: true, value: true }, { label: 'Cancel', value: null }]);
    if (!(await m.done)) return;
    const mm = 72 / 25.4;
    const idx = scope.value === 'all' ? identity(doc.numPages) : pages;
    const bytes = await io.cropPages(doc.bytes, idx, { l: +l.value * mm, r: +r.value * mm, t: +t.value * mm, b: +b.value * mm });
    await doc.replaceBytes(bytes, identity(doc.numPages));
    this.app.sidebar.refresh();
  }

  // ---------- forms ----------
  async renderForms(container) {
    const doc = this.doc;
    container.append(el('div', { class: 'side-hint' }, 'Reading form fields…'));
    let fields = [];
    try { fields = await io.listFormFields(doc.bytes); } catch (e) { console.warn(e); }
    container.textContent = '';
    if (!fields.length) { container.append(el('div', { class: 'side-hint' }, 'This PDF has no fillable form fields. Use the Text tool to type anywhere on the page, or Signature to sign.')); return; }
    container.append(el('div', { class: 'side-hint' }, `${fields.length} field(s). Values are written into the PDF when you save.`));
    const list = el('div', { class: 'list' });
    for (const f of fields) {
      const cur = doc.formValues[f.name] !== undefined ? doc.formValues[f.name] : f.value;
      let input;
      if (f.kind === 'CheckBox') { input = el('input', { type: 'checkbox' }); input.checked = !!cur; }
      else if (f.options) { input = el('select', {}, el('option', { value: '' }, '—'), ...f.options.map(o => el('option', { value: o }, o))); input.value = cur || ''; }
      else if (f.kind === 'TextField') { input = el('input', { value: cur || '', style: { width: '100%' } }); }
      else { input = el('span', { style: { color: 'var(--fg3)' } }, f.kind); }
      input.addEventListener && input.addEventListener('change', () => {
        doc.formValues[f.name] = input.type === 'checkbox' ? input.checked : input.value;
        doc.markContent();
      });
      const entry = el('div', { class: 'entry' }, el('div', { class: 'meta' }, el('span', {}, f.name), el('span', {}, f.widgets[0] ? 'p. ' + (f.widgets[0].page + 1) : '')), input);
      entry.addEventListener('click', (e) => { if (e.target === entry && f.widgets[0]) this.app.active.goto(f.widgets[0].page, { pdfY: f.widgets[0].rect[3] + 40 }); });
      list.append(entry);
    }
    container.append(list);
  }
}

// ---------- helpers ----------
function identity(n) { return Array.from({ length: n }, (_, i) => i); }

function sampleColors(canvas, x, y, w, h, cssW) {
  const res = { fg: [0, 0, 0], bg: [1, 1, 1] };
  if (!canvas) return res;
  try {
    const k = canvas.width / cssW;
    const sx = Math.max(0, Math.floor(x * k)), sy = Math.max(0, Math.floor(y * k));
    const sw = Math.max(1, Math.min(canvas.width - sx, Math.ceil(w * k))), sh = Math.max(1, Math.min(canvas.height - sy, Math.ceil(h * k)));
    const d = canvas.getContext('2d').getImageData(sx, sy, sw, sh).data;
    let minL = 1e9, maxL = -1, fg = null, bg = null;
    // background: most frequent light colour; foreground: darkest
    const counts = new Map();
    for (let i = 0; i < d.length; i += 4) {
      const L = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
      if (L < minL) { minL = L; fg = [d[i], d[i + 1], d[i + 2]]; }
      const key = (d[i] >> 3) << 10 | (d[i + 1] >> 3) << 5 | (d[i + 2] >> 3);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    let best = 0, bk = null;
    for (const [kk, c] of counts) if (c > best) { best = c; bk = kk; }
    if (bk != null) bg = [((bk >> 10) & 31) * 8 + 4, ((bk >> 5) & 31) * 8 + 4, (bk & 31) * 8 + 4];
    if (fg) res.fg = fg.map(c => c / 255);
    if (bg) res.bg = bg.map(c => Math.min(1, c / 255));
    if (bg && bg.every(c => c > 235)) res.bg = [1, 1, 1];
  } catch (_) {}
  return res;
}

function imageSize(data, type) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(new Blob([data], { type: type === 'jpg' ? 'image/jpeg' : 'image/png' }));
    const img = new Image();
    img.onload = () => { resolve({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(url); };
    img.onerror = () => resolve({ w: 100, h: 100 });
    img.src = url;
  });
}

function trimCanvas(c) {
  const ctx = c.getContext('2d');
  const { width, height } = c;
  const d = ctx.getImageData(0, 0, width, height).data;
  let x1 = width, y1 = height, x2 = 0, y2 = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (d[(y * width + x) * 4 + 3] > 10) { if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y; }
  if (x2 <= x1) return c.toDataURL('image/png');
  const p = 6;
  x1 = Math.max(0, x1 - p); y1 = Math.max(0, y1 - p); x2 = Math.min(width, x2 + p); y2 = Math.min(height, y2 + p);
  const o = document.createElement('canvas');
  o.width = x2 - x1; o.height = y2 - y1;
  o.getContext('2d').drawImage(c, x1, y1, o.width, o.height, 0, 0, o.width, o.height);
  return o.toDataURL('image/png');
}

function dataUrlToBytes(url) {
  const b = atob(url.split(',')[1]);
  const a = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
  return a;
}
