// PDF-Bat renderer entry point.
import { Doc } from './doc.js';
import { Pane } from './pane.js';
import { Sidebar } from './sidebar.js';
import { Editor } from './edit.js';
import { el, $, $$, toast, debounce, hexToRgb, rgbToHex, prompt, modal, clamp } from './util.js';

const HL_COLORS = ['#ffd400', '#7bd88f', '#5ec8f2', '#ff8fb1', '#c792ea', '#ff9e57'];
const PEN_COLORS = ['#d9453b', '#1d4ed8', '#111111', '#16a34a', '#f59e0b', '#9333ea'];

const READ_TOOLS = [
  ['select', '⌶', 'Select text (V)', 'v'],
  ['hand', '✋', 'Pan (Space-drag / H)', 'h'],
  ['highlight', '▍', 'Highlight (A)', 'a'],
  ['underline', 'U̲', 'Underline (U)', 'u'],
  ['strike', 'S̶', 'Strike-through (S)', 's'],
  ['pen', '✎', 'Pen (P), Shift = straight line', 'p'],
  ['marker', '🖍', 'Marker (M)', 'm'],
  ['eraser', '⌫', 'Eraser (E)', 'e'],
  ['note', '🗨', 'Sticky note (N)', 'n'],
  ['snap', '⛶', 'Snapshot region to clipboard (X)', 'x']
];
const EDIT_TOOLS = [
  ['eselect', '↖', 'Select / move objects (V)', 'v'],
  ['edittext', 'Ꞁ✎', 'Edit existing text: click a word/line (R)', 'r'],
  ['text', 'T', 'Add text (T)', 't'],
  ['latex', '∑', 'Insert LaTeX (L)', 'l'],
  ['image', '🖼', 'Insert image (I)', 'i'],
  ['signature', '✍', 'Signature (G)', 'g'],
  ['whiteout', '▭', 'Whiteout / cover (W)', 'w'],
  ['rect', '□', 'Rectangle (B)', 'b'],
  ['line', '╱', 'Line (Shift = 45°)', 'k'],
  ['arrow', '↗', 'Arrow (Q)', 'q']
];

class App {
  constructor() {
    this.panes = [];
    this.active = null;
    this.mode = 'read';
    this.tool = 'select';
    this.lastTool = { read: 'select', edit: 'eselect' };
    this.highlightColor = HL_COLORS[0];
    this.penColor = PEN_COLORS[0];
    this.penWidth = 1.5;
    this.markerColor = HL_COLORS[0];
    this.noteColor = '#ffd400';
    this.settings = {};
    this.sidebar = new Sidebar(this);
    this.editor = new Editor(this);
    this.saveSession = debounce(() => this._saveSession(), 800);
  }

  async init() {
    document.documentElement.classList.toggle('mac', window.bat.platform === 'darwin');
    document.body.classList.toggle('mac', window.bat.platform === 'darwin');
    this.settings = (await window.bat.getSettings()) || {};
    window.__settings = this.settings;
    const sysDark = await window.bat.systemDark();
    this.applyTheme(this.settings.theme || (sysDark ? 'dark' : 'light'));
    this.applyDarkPages(!!this.settings.darkPages);
    if (this.settings.sidebarWidth) $('#sidebar').style.width = this.settings.sidebarWidth + 'px';
    if (this.settings.sidebarHidden) $('#sidebar').classList.add('hidden');
    Object.assign(this, pick(this.settings, ['highlightColor', 'penColor', 'penWidth', 'markerColor']));
    this.bindChrome();
    this.renderToolbar();
    this.sidebar.refresh();
    await this.restoreSession();
    const pending = await window.bat.pendingPaths();
    if (pending.length) await this.openPaths(pending);
    this.updateWelcome();
  }

  // ---------- chrome ----------
  bindChrome() {
    $('#btnOpen').addEventListener('click', () => this.openDialog());
    $('#welcomeOpen').addEventListener('click', (e) => { e.preventDefault(); this.openDialog(); });
    $('#btnTheme').addEventListener('click', () => this.toggleTheme());
    $('#btnDarkPdf').addEventListener('click', () => this.applyDarkPages(!this.settings.darkPages, true));
    $$('#modeSwitch button').forEach(b => b.addEventListener('click', () => this.setMode(b.dataset.mode)));
    window.bat.onMenu((cmd) => this.command(cmd));
    window.bat.onOpenPaths((ps) => this.openPaths(ps));
    window.bat.onCloseRequest(() => this.onCloseRequest());
    window.bat.onUpdateStatus && window.bat.onUpdateStatus((u) => {
      if (u.status === 'downloading' && u.version && this._updToast !== u.version) { this._updToast = u.version; toast(`Downloading PDF-Bat ${u.version} in the background…`, 4000); }
    });
    window.bat.onTexProgress && window.bat.onTexProgress((g, t) => this.emitTexProgress && this.emitTexProgress(g, t));
    // drag & drop
    let depth = 0;
    window.addEventListener('dragenter', (e) => { if (e.dataTransfer.types.includes('Files')) { depth++; document.body.classList.add('dropping'); } });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) document.body.classList.remove('dropping'); });
    window.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
    window.addEventListener('drop', (e) => {
      depth = 0; document.body.classList.remove('dropping');
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      const paths = Array.from(e.dataTransfer.files).map(f => window.bat.pathForFile(f)).filter(p => /\.pdf$/i.test(p));
      const tex = Array.from(e.dataTransfer.files).map(f => window.bat.pathForFile(f)).filter(p => /\.tex$/i.test(p));
      if (paths.length) this.openPaths(paths);
      for (const t of tex) this.openTexFile(t);
    });
    // sidebar resizer
    const rz = $('#sideResizer');
    rz.addEventListener('pointerdown', (e) => {
      rz.setPointerCapture(e.pointerId); rz.classList.add('drag');
      const sb = $('#sidebar');
      const move = (m) => { sb.style.width = clamp(m.clientX, 160, 600) + 'px'; };
      const up = () => { rz.classList.remove('drag'); rz.removeEventListener('pointermove', move); rz.removeEventListener('pointerup', up); this.setSettings({ sidebarWidth: sb.offsetWidth }); };
      rz.addEventListener('pointermove', move); rz.addEventListener('pointerup', up);
    });
    document.addEventListener('keydown', (e) => this.onKey(e));
    document.addEventListener('mousedown', (e) => {
      if (this.selPop && !this.selPop.contains(e.target)) this.closeSelPop();
      if (this.popupCloser && !(e.target.closest && e.target.closest('.note-pop'))) { const c = this.popupCloser; this.popupCloser = null; c(); }
    });
  }

  command(cmd) {
    const p = this.active && this.active.isTex && !['save', 'saveAs', 'closePane', 'open', 'modeRead', 'modeEdit', 'sidebar', 'theme', 'openTex', 'newTex'].includes(cmd) ? this.active.previewPane : this.active;
    const map = {
      open: () => this.openDialog(),
      save: () => this.save(),
      saveAs: () => this.save(true),
      closePane: () => p && this.closePane(p),
      modeRead: () => this.setMode('read'),
      modeEdit: () => this.setMode('edit'),
      duplicate: () => p && this.duplicatePane(p),
      sidebar: () => { const h = $('#sidebar').classList.toggle('hidden'); this.setSettings({ sidebarHidden: h }); },
      theme: () => this.toggleTheme(),
      zoomIn: () => p && p.zoomBy(1.15),
      zoomOut: () => p && p.zoomBy(1 / 1.15),
      fitWidth: () => p && p.setZoom('fitWidth'),
      find: () => this.openFind(),
      openTex: () => this.openTexDialog(),
      newTex: () => this.newTex(),
      quickOpen: () => this.quickOpen()
    };
    if (map[cmd]) map[cmd]();
  }

  onKey(e) {
    const t = e.target;
    const typing = t.closest && t.closest('input,textarea,select,[contenteditable="true"],[contenteditable="plaintext-only"]');
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); this.undo(); return; }
    if (mod && ((e.shiftKey && e.key.toLowerCase() === 'z') || e.key.toLowerCase() === 'y') && !typing) { e.preventDefault(); this.redo(); return; }
    if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); this.openFind(); return; }
    if (mod && e.key.toLowerCase() === 'p' && !e.shiftKey) { e.preventDefault(); this.quickOpen(); return; }
    if (mod && e.key.toLowerCase() === 'j' && !e.repeat) { e.preventDefault(); this.command('duplicate'); return; }
    if (typing) return;
    if (e.key === 'Escape') { import('./preview.js').then(m => m.hidePreview()); this.closeSelPop(); this.closeFind(); if (this.tool !== this.defaultTool()) this.setTool(this.defaultTool()); return; }
    if (e.altKey && e.key === 'ArrowLeft' && this.active) { e.preventDefault(); this.active.back(); return; }
    if (e.altKey && e.key === 'ArrowRight' && this.active) { e.preventDefault(); this.active.forward(); return; }
    if (mod || e.altKey) return;
    const p = this.active;
    if (p && (e.key === 'PageDown' || e.key === 'PageUp' || e.key === ' ' || e.key === 'Home' || e.key === 'End')) {
      // keep keyboard scrolling working even when focus is elsewhere
      if (document.activeElement !== p.scrollEl) { p.scrollEl.focus({ preventScroll: true }); }
      if (e.key === 'Home') { e.preventDefault(); p.goto(0, { push: true }); }
      if (e.key === 'End') { e.preventDefault(); p.goto(p.doc.numPages - 1, { push: true }); }
      return;
    }
    if (p && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && p.zoomMode === 'fitPage') {
      e.preventDefault(); p.goto(p.current + (e.key === 'ArrowRight' ? 1 : -1)); return;
    }
    const tools = this.mode === 'edit' ? EDIT_TOOLS : READ_TOOLS;
    const hit = tools.find(x => x[3] === e.key.toLowerCase());
    if (hit) { e.preventDefault(); this.setTool(hit[0]); return; }
    if (e.key === 'b' && p && this.mode === 'read') { p.toggleBookmark(); }
  }

  undo() { const d = this.active && this.active.doc; if (d && d.undo()) toast('Undo'); }
  redo() { const d = this.active && this.active.doc; if (d && d.redo()) toast('Redo'); }

  // ---------- theme ----------
  applyTheme(t) {
    document.documentElement.dataset.theme = t;
    $('#btnTheme').textContent = t === 'dark' ? '☀' : '☾';
    this.settings.theme = t;
  }
  toggleTheme() {
    const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    this.applyTheme(t);
    this.setSettings({ theme: t });
  }
  applyDarkPages(on, persist) {
    document.body.classList.toggle('dark-pages', on);
    $('#btnDarkPdf').classList.toggle('on', on);
    this.settings.darkPages = on;
    if (persist) this.setSettings({ darkPages: on });
  }
  async setSettings(patch) {
    Object.assign(this.settings, patch);
    await window.bat.setSettings(patch);
  }

  // ---------- modes & tools ----------
  setMode(m) {
    if (this.mode === m) return;
    this.lastTool[this.mode] = this.tool;
    this.mode = m;
    document.body.classList.toggle('edit-mode', m === 'edit');
    $$('#modeSwitch button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
    this.editor.select(null, null);
    this.setTool(this.lastTool[m]);
    this.sidebar.refresh();
  }
  defaultTool() { return this.mode === 'edit' ? 'eselect' : 'select'; }
  setTool(t) {
    this.tool = t;
    document.body.className = document.body.className.split(' ').filter(c => !c.startsWith('tool-')).join(' ');
    document.body.classList.add('tool-' + t);
    if (this.editor.isBoxTool(t)) document.body.classList.add('tool-box');
    this.renderToolbar();
  }
  penOptions(tool) {
    if (tool === 'marker') return { color: this.markerColor, width: 10, opacity: 0.35 };
    return { color: this.penColor, width: this.penWidth, opacity: 1 };
  }

  updateToolbar() { this.renderToolbar(); }
  renderToolbar() {
    const tb = $('#toolbar');
    tb.textContent = '';
    const tools = this.mode === 'edit' ? EDIT_TOOLS : READ_TOOLS;
    for (const [id, icon, title] of tools) {
      tb.append(el('button', { class: 'tool' + (this.tool === id ? ' on' : ''), title, onclick: () => this.setTool(id) }, icon));
    }
    tb.append(el('div', { class: 'sep' }));
    const swatches = (colors, cur, set) => colors.map(c => el('span', { class: 'swatch' + (c === cur ? ' on' : ''), style: { background: c }, title: c, onclick: () => { set(c); this.renderToolbar(); } }));
    const t = this.tool;
    if (this.mode === 'read') {
      if (t === 'highlight' || t === 'underline' || t === 'strike' || t === 'select') tb.append(...swatches(HL_COLORS, this.highlightColor, c => { this.highlightColor = c; this.setSettings({ highlightColor: c }); }));
      else if (t === 'pen') {
        tb.append(...swatches(PEN_COLORS, this.penColor, c => { this.penColor = c; this.setSettings({ penColor: c }); }));
        const w = el('input', { type: 'range', min: 0.5, max: 8, step: 0.5, value: this.penWidth, title: 'Width' });
        w.addEventListener('input', () => { this.penWidth = +w.value; this.setSettings({ penWidth: this.penWidth }); });
        tb.append(w);
      } else if (t === 'marker') tb.append(...swatches(HL_COLORS, this.markerColor, c => { this.markerColor = c; this.setSettings({ markerColor: c }); }));
      else if (t === 'note') tb.append(...swatches(HL_COLORS, this.noteColor, c => { this.noteColor = c; }));
      tb.append(el('div', { class: 'sep' }));
      tb.append(el('button', { class: this.active && this.active.ruler ? 'on' : '', title: 'Reading ruler', onclick: () => { if (this.active) { this.active.setRuler(!this.active.ruler); this.renderToolbar(); } } }, '☰'));
      tb.append(el('button', { title: 'Find (Ctrl+F)', onclick: () => this.openFind() }, '🔍'));
    } else {
      const ed = this.editor;
      const sel = ed.selectedEdit();
      if (t === 'text' || t === 'edittext' || (sel && sel.type === 'text')) {
        const size = el('input', { type: 'number', min: 4, max: 144, step: 0.5, value: sel && sel.type === 'text' ? sel.size : ed.textSize, style: { width: '56px' }, title: 'Font size (pt)' });
        size.addEventListener('change', () => { ed.textSize = +size.value; if (sel && sel.type === 'text') sel && this.active.doc.updateEdit(sel.id, { size: +size.value }, true); });
        const font = el('select', { title: 'Font' }, el('option', { value: 'sans' }, 'Sans'), el('option', { value: 'serif' }, 'Serif'), el('option', { value: 'mono' }, 'Mono'));
        font.value = sel && sel.type === 'text' ? (sel.font || 'sans') : ed.textFont;
        font.addEventListener('change', () => { ed.textFont = font.value; if (sel && sel.type === 'text') this.active.doc.updateEdit(sel.id, { font: font.value }, true); });
        const col = el('input', { type: 'color', value: sel && sel.type === 'text' ? rgbToHex(sel.color) : ed.textColor, title: 'Colour', style: { width: '32px', padding: '0 2px' } });
        col.addEventListener('input', () => { ed.textColor = col.value; if (sel && sel.type === 'text') this.active.doc.updateEdit(sel.id, { color: hexToRgb(col.value) }); });
        tb.append(size, font, col);
      }
      if (t === 'rect' || t === 'line' || t === 'arrow' || (sel && ['rect', 'line', 'arrow'].includes(sel.type))) {
        const col = el('input', { type: 'color', value: sel && sel.color ? rgbToHex(sel.color) : ed.strokeColor, title: 'Colour', style: { width: '32px', padding: '0 2px' } });
        col.addEventListener('input', () => { ed.strokeColor = col.value; if (sel && ['rect', 'line', 'arrow'].includes(sel.type)) this.active.doc.updateEdit(sel.id, { color: hexToRgb(col.value) }); });
        const w = el('input', { type: 'range', min: 0.5, max: 8, step: 0.5, value: sel && sel.width ? sel.width : ed.strokeWidth, title: 'Width' });
        w.addEventListener('input', () => { ed.strokeWidth = +w.value; if (sel && ['rect', 'line', 'arrow'].includes(sel.type)) this.active.doc.updateEdit(sel.id, { width: +w.value }); });
        tb.append(col, w);
      }
      if (sel) tb.append(el('button', { title: 'Delete object (Del)', onclick: () => { this.active.doc.removeEdit(sel.id); ed.select(null, null); } }, '🗑'));
      tb.append(el('div', { class: 'sep' }));
      tb.append(el('button', { title: 'Save (Ctrl+S)', onclick: () => this.save() }, '💾 Save'));
      tb.append(el('button', { title: 'New LaTeX document (Ctrl+N)', onclick: () => this.newTex() }, '∑ New .tex'));
    }
  }

  // ---------- files ----------
  async openDialog() {
    const paths = await window.bat.openDialog();
    if (paths.length) await this.openPaths(paths);
  }
  async openPaths(paths) {
    for (const p of paths) {
      if (/\.tex$/i.test(p)) { this.openTexFile(p); continue; }
      try {
        const existing = this.panes.find(x => !x.isTex && x.doc.path === p);
        if (existing) { this.setActive(existing); continue; }
        const doc = await Doc.open(p);
        await this.addPane(doc);
      } catch (e) {
        console.error(e);
        toast(`Could not open ${p.split(/[\\/]/).pop()}: ${e.message}`, 5000);
      }
    }
    this.updateWelcome();
  }

  async addPane(doc, opts = {}, after) {
    const pane = new Pane(this, doc, opts);
    const container = $('#panes');
    if (after && after.root.nextSibling) {
      container.insertBefore(pane.root, after.root.nextSibling);
      const idx = this.panes.indexOf(after);
      this.panes.splice(idx + 1, 0, pane);
    } else {
      this.panes.push(pane);
    }
    await pane.mount(container, opts);
    if (after && pane.root.parentNode && after.root.nextSibling !== pane.root) container.insertBefore(pane.root, after.root.nextSibling);
    this.layoutPanes();
    this.setActive(pane);
    this.updateWelcome();
    this.saveSession();
    return pane;
  }

  layoutPanes() {
    const c = $('#panes');
    $$('.resizer.pane-rz', c).forEach(r => r.remove());
    const kids = Array.from(c.children).filter(x => x.classList.contains('pane') || x.classList.contains('texpane'));
    kids.forEach((k, i) => {
      if (i === 0) return;
      const rz = el('div', { class: 'resizer v pane-rz' });
      c.insertBefore(rz, k);
      rz.addEventListener('pointerdown', (e) => {
        rz.setPointerCapture(e.pointerId); rz.classList.add('drag');
        const a = kids[i - 1], b = k;
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        const total = ra.width + rb.width, ga = parseFloat(a.style.flexGrow || 1), gb = parseFloat(b.style.flexGrow || 1);
        const move = (m) => {
          const w = clamp(m.clientX - ra.left, 200, total - 200);
          const g = ga + gb;
          a.style.flexGrow = String(g * w / total); b.style.flexGrow = String(g * (total - w) / total);
        };
        const up = () => { rz.classList.remove('drag'); rz.removeEventListener('pointermove', move); rz.removeEventListener('pointerup', up); };
        rz.addEventListener('pointermove', move); rz.addEventListener('pointerup', up);
      });
    });
  }

  setActive(pane) {
    if (this.active === pane) return;
    this.active = pane;
    for (const p of this.panes) p.root.classList.toggle('active', p === pane);
    this.sidebar.refresh();
    this.renderToolbar();
    if (this.findBar) this.closeFind();
  }

  async duplicatePane(p) {
    if (!p || p.isTex) return;
    const np = await this.addPane(p.doc, { page: p.current, offset: p.pageOffsetFraction(), zoomMode: p.zoomMode, scale: p.scale }, p);
    toast('Duplicated — both panes share highlights and notes');
    return np;
  }

  async closePane(p) {
    if (p.isTex) { if (!(await p.confirmClose())) return; }
    else if (p.doc.refs <= 1 && p.doc.contentDirty) {
      const r = await window.bat.confirm(`Save changes to “${p.doc.name}”?`, 'Your edits will be lost if you don’t save them.', ['Save', 'Don’t save', 'Cancel']);
      if (r === 2) return;
      if (r === 0) await this.saveDoc(p.doc);
    }
    const i = this.panes.indexOf(p);
    this.panes.splice(i, 1);
    p.destroy();
    this.layoutPanes();
    if (this.active === p) { this.active = null; this.setActive(this.panes[Math.min(i, this.panes.length - 1)] || null); }
    if (!this.panes.length) { this.sidebar.refresh(); this.renderToolbar(); }
    this.updateWelcome();
    this.saveSession();
  }

  forEachPaneOf(doc, fn) { for (const p of this.panes) if (p.doc === doc) fn(p); }

  onPaneMoved(p) {
    if (p === this.active) this.sidebar.onPaneMoved();
  }

  async save(as) {
    const p = this.active;
    if (!p) return;
    if (p.isTex) { await p.save(as); return; }
    await this.saveDoc(p.doc, as);
  }
  async saveDoc(doc, as) {
    let target = null;
    if (as) {
      target = await window.bat.saveDialog(doc.path.replace(/\.pdf$/i, '') + ' copy.pdf');
      if (!target) return;
    }
    try {
      await doc.save(target);
      this.forEachPaneOf(doc, (pp) => pp.updateHead());
      toast('Saved ' + doc.name);
      this.saveSession();
      this.sidebar.refresh();
    } catch (e) {
      console.error(e);
      toast('Save failed: ' + e.message, 6000);
    }
  }

  async onCloseRequest() {
    const dirty = Doc.all().filter(d => d.contentDirty);
    const texDirty = this.panes.filter(p => p.isTex && p.dirty);
    if (dirty.length || texDirty.length) {
      const names = dirty.map(d => d.name).concat(texDirty.map(p => p.name)).join(', ');
      const r = await window.bat.confirm('Save changes before closing?', names, ['Save all', 'Don’t save', 'Cancel']);
      if (r === 2) { window.bat.cancelClose(); return; }
      if (r === 0) {
        for (const d of dirty) await this.saveDoc(d);
        for (const t of texDirty) await t.save();
      }
    }
    // flush annotation autosaves
    await Promise.all(Doc.all().map(d => (d.annoDirty && !d.contentDirty ? d.saveAnnotations() : null)));
    this._saveSession();
    await new Promise(r => setTimeout(r, 150));
    window.bat.closeWindow();
  }

  // ---------- quick open (Ctrl+P) ----------
  async quickOpen() {
    if (this._qo) return;
    const recent = await window.bat.getRecent();
    const open = this.panes.filter(p => !p.isTex).map(p => p.doc.path);
    const all = Array.from(new Set(open.concat(recent)));
    const input = el('input', { placeholder: 'Type to filter recent files…', style: { width: '100%' } });
    const list = el('div', { class: 'list', style: { maxHeight: '50vh', overflow: 'auto', marginTop: '8px' } });
    let items = [], sel = 0;
    const score = (p, q) => {
      if (!q) return 1;
      const name = p.split(/[\\/]/).pop().toLowerCase();
      q = q.toLowerCase();
      if (name.includes(q)) return 3 - name.indexOf(q) / 100;
      let i = 0; for (const c of name) if (c === q[i]) i++;
      return i === q.length ? 1 : (p.toLowerCase().includes(q) ? 0.5 : 0);
    };
    const render = () => {
      items = all.map(p => [p, score(p, input.value)]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]).map(x => x[0]).slice(0, 30);
      sel = Math.min(sel, Math.max(0, items.length - 1));
      list.textContent = '';
      items.forEach((p, i) => {
        const r = el('div', { class: 'entry', style: { borderLeftColor: i === sel ? 'var(--accent)' : 'transparent', background: i === sel ? 'var(--bg3)' : '' } },
          el('div', {}, p.split(/[\\/]/).pop() + (open.includes(p) ? '  ·  open' : '')), el('div', { class: 'meta' }, p));
        r.addEventListener('click', () => go(p));
        list.append(r);
      });
      if (!items.length) list.append(el('div', { class: 'side-hint' }, 'No matching files. Ctrl+O to browse.'));
    };
    const go = (p) => { m.close(null); if (p) this.openPaths([p]); };
    const m = modal('Open recent', [el('div', { style: { width: 'min(560px, 86vw)' } }, input, list)], [{ label: 'Browse…', action: () => { this.openDialog(); return null; } }, { label: 'Cancel', value: null }]);
    this._qo = m;
    m.done.then(() => { this._qo = null; });
    input.addEventListener('input', () => { sel = 0; render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); render(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
      if (e.key === 'Enter') { e.preventDefault(); go(items[sel]); }
    });
    render();
    setTimeout(() => input.focus(), 0);
  }

  // ---------- session ----------
  _saveSession() {
    const s = {
      panes: this.panes.map(p => p.isTex ? { tex: p.path } : { path: p.doc.path, page: p.current, offset: p.pageOffsetFraction(), zoomMode: p.zoomMode, scale: p.scale, spread: p.spread }),
      active: this.panes.indexOf(this.active),
      mode: this.mode
    };
    window.bat.setSession(s);
  }
  async restoreSession() {
    const s = await window.bat.getSession();
    if (!s || !s.panes) return;
    for (const ps of s.panes) {
      try {
        if (ps.tex) { if (await window.bat.exists(ps.tex)) await this.openTexFile(ps.tex); continue; }
        if (!(await window.bat.exists(ps.path))) continue;
        const doc = await Doc.open(ps.path);
        await this.addPane(doc, { page: ps.page, offset: ps.offset, zoomMode: ps.zoomMode, scale: ps.scale, spread: ps.spread });
      } catch (e) { console.warn('restore failed', ps, e); }
    }
    if (s.active >= 0 && this.panes[s.active]) this.setActive(this.panes[s.active]);
    if (s.mode === 'edit') this.setMode('edit');
  }

  async updateWelcome() {
    const w = $('#welcome');
    w.style.display = this.panes.length ? 'none' : 'flex';
    if (this.panes.length) return;
    const rec = await window.bat.getRecent();
    const list = $('#recentList');
    list.textContent = '';
    if (rec.length) list.append(el('div', { style: { color: 'var(--fg3)', cursor: 'default', background: 'none' } }, 'Recent'));
    for (const r of rec.slice(0, 10)) list.append(el('div', { title: r, onclick: () => this.openPaths([r]) }, r.split(/[\\/]/).pop()));
  }

  // ---------- popups ----------
  closePopups() {
    if (this.popupCloser) { const c = this.popupCloser; this.popupCloser = null; c(); }
    this.closeSelPop();
  }
  closeSelPop() { if (this.selPop) { this.selPop.remove(); this.selPop = null; } }

  showSelectionPopup(pane, x, y) {
    this.closeSelPop();
    const mk = (type, label, title) => el('button', { title, onclick: () => { pane.annotateSelection(type, this.highlightColor); window.getSelection().removeAllRanges(); this.closeSelPop(); } }, label);
    const pop = el('div', { class: 'sel-pop', style: { left: x + 'px', top: (y + 12) + 'px' } },
      ...HL_COLORS.slice(0, 5).map(c => el('span', { class: 'swatch', style: { background: c }, title: 'Highlight', onclick: () => { pane.annotateSelection('highlight', c); window.getSelection().removeAllRanges(); this.closeSelPop(); } })),
      mk('underline', 'U̲', 'Underline'), mk('strike', 'S̶', 'Strike-through'),
      el('button', { title: 'Highlight + note', onclick: async () => {
        const text = window.getSelection().toString();
        const a = pane.annotateSelection('highlight', this.highlightColor);
        window.getSelection().removeAllRanges();
        this.closeSelPop();
        if (a) { const n = await prompt('Note for highlight', '', text.slice(0, 120)); if (n) pane.doc.updateAnnotation(a.id, { note: n }); }
      } }, '🗨'),
      el('button', { title: 'Copy', onclick: () => { window.bat.copyText(window.getSelection().toString()); this.closeSelPop(); toast('Copied'); } }, '⧉'));
    pop.addEventListener('mousedown', (e) => e.preventDefault());
    document.body.append(pop);
    const r = pop.getBoundingClientRect();
    if (r.right > innerWidth - 8) pop.style.left = (innerWidth - r.width - 8) + 'px';
    if (r.bottom > innerHeight - 8) pop.style.top = (y - r.height - 12) + 'px';
    this.selPop = pop;
  }

  openAnnoPopup(pane, a, x, y) {
    this.closeSelPop();
    const colors = el('div', { style: { display: 'flex', gap: '2px' } }, ...HL_COLORS.map(c => el('span', { class: 'swatch', style: { background: c }, onclick: () => { pane.doc.updateAnnotation(a.id, { color: hexToRgb(c) }); this.closeSelPop(); } })));
    const pop = el('div', { class: 'sel-pop', style: { left: x + 'px', top: (y + 10) + 'px', flexDirection: 'column', alignItems: 'stretch', width: '220px', padding: '6px' } },
      colors,
      a.text ? el('div', { style: { color: 'var(--fg3)', fontSize: '11px', margin: '4px 2px', maxHeight: '4em', overflow: 'hidden' } }, '“' + a.text + '”') : null,
      el('div', { style: { display: 'flex', gap: '2px', marginTop: '4px' } },
        ...(['highlight', 'underline', 'strike'].includes(a.type) ? [['highlight', '▍'], ['underline', 'U̲'], ['strike', 'S̶']].map(([k, l]) => el('button', { class: a.type === k ? 'on' : '', title: k, onclick: () => { pane.doc.updateAnnotation(a.id, { type: k, opacity: k === 'highlight' ? 0.4 : 1 }); this.closeSelPop(); } }, l)) : []),
        el('button', { title: 'Note', onclick: async () => { this.closeSelPop(); const n = await prompt('Note', a.note || ''); if (n != null) pane.doc.updateAnnotation(a.id, { note: n }); } }, '🗨'),
        a.text ? el('button', { title: 'Copy text', onclick: () => { window.bat.copyText(a.text); this.closeSelPop(); toast('Copied'); } }, '⧉') : null,
        el('div', { class: 'spacer' }),
        el('button', { title: 'Delete', onclick: () => { pane.doc.removeAnnotation(a.id); this.closeSelPop(); } }, '🗑')));
    document.body.append(pop);
    const r = pop.getBoundingClientRect();
    if (r.right > innerWidth - 8) pop.style.left = (innerWidth - r.width - 8) + 'px';
    if (r.bottom > innerHeight - 8) pop.style.top = (y - r.height - 10) + 'px';
    this.selPop = pop;
  }

  prompt(t, v) { return prompt(t, v); }

  // ---------- snapshot ----------
  async snapshot(pane, v, r) {
    // re-render the region at high resolution
    const scale = Math.max(3, pane.scale * 2);
    const page = pane.doc.proxies[v.i];
    const vp = page.getViewport({ scale });
    const k = scale / pane.scale;
    const c = document.createElement('canvas');
    c.width = Math.round(r.w * k); c.height = Math.round(r.h * k);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -r.x * k, -r.y * k] }).promise;
    window.bat.copyImage(c.toDataURL('image/png'));
    toast('Snapshot copied to clipboard');
  }

  // ---------- find ----------
  openFind() {
    const p = this.active;
    if (!p || p.isTex) return;
    if (this.findBar) { this.findInput.focus(); this.findInput.select(); return; }
    const input = el('input', { placeholder: 'Find in document…' });
    const info = el('span', { class: 'info' });
    const go = async (dir) => {
      const r = await p.runFind(input.value, dir);
      info.textContent = r.total ? `${(r.idx ?? 0) + 1} / ${r.total}${r.done ? '' : '+'}` : (input.value ? 'No results' : '');
    };
    this.onFindProgress = (pp) => {
      if (pp !== p || !pp.find) return;
      const f = pp.find;
      info.textContent = f.pages.length ? `${Math.max(0, f.idx) + 1} / ${f.pages.length}${f.done ? '' : '+'}` : (f.done ? 'No results' : 'Searching…');
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? -1 : 1); }
      if (e.key === 'Escape') { e.preventDefault(); this.closeFind(); }
    });
    const bar = el('div', { class: 'findbar' }, input, info,
      el('button', { title: 'Previous (Shift+Enter)', onclick: () => go(-1) }, '↑'),
      el('button', { title: 'Next (Enter)', onclick: () => go(1) }, '↓'),
      el('button', { onclick: () => this.closeFind() }, '✕'));
    p.root.append(bar);
    this.findBar = bar; this.findInput = input; this.findPane = p;
    input.focus();
  }
  closeFind() {
    if (!this.findBar) return;
    this.findBar.remove();
    this.findBar = null;
    if (this.findPane) { this.findPane.find = null; this.findPane.clearFindMarks(); }
  }

  // ---------- LaTeX (loaded only in Edit mode) ----------
  async latexModule() {
    if (!this._latex) this._latex = import('./latex.js').then(m => m.init(this));
    return this._latex;
  }
  async openLatexSnippet(pane, opts) {
    if (this.mode !== 'edit') this.setMode('edit');
    const L = await this.latexModule();
    return L.snippet(pane, opts);
  }
  async newTex() {
    if (this.mode !== 'edit') this.setMode('edit');
    const L = await this.latexModule();
    return L.newDocument();
  }
  async openTexDialog() {
    const p = await window.bat.openTexDialog();
    if (p) this.openTexFile(p);
  }
  async openTexFile(path) {
    if (this.mode !== 'edit') this.setMode('edit');
    const L = await this.latexModule();
    return L.openFile(path);
  }
}

function pick(o, keys) { const r = {}; for (const k of keys) if (o[k] !== undefined) r[k] = o[k]; return r; }

const app = new App();
window.app = app;
app.init().catch(e => { console.error(e); toast('Startup error: ' + e.message, 8000); });
