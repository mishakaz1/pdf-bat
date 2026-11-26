// Sidebar: contents (outline), page thumbnails / organizer, notes & highlights, bookmarks, forms.
import { el, $, debounce, rgbToHex, toast, fmtDate } from './util.js';
import { getOutline, flatten } from './outline.js';
import { pdfjsLib } from './doc.js';

const READ_TABS = [['contents', 'Contents'], ['pages', 'Pages'], ['notes', 'Notes'], ['bookmarks', 'Bookmarks']];
const EDIT_TABS = [['organize', 'Pages'], ['contents', 'Contents'], ['forms', 'Forms']];

export class Sidebar {
  constructor(app) {
    this.app = app;
    this.tabsEl = $('#sideTabs');
    this.body = $('#sideBody');
    this.tab = { read: 'contents', edit: 'organize' };
    this.collapsed = new Set();
    this.selectedPages = new Set();
    this.refreshSoon = debounce(() => this.refresh(), 150);
  }

  get pane() { return this.app.active; }
  get doc() { return this.app.active && this.app.active.doc; }

  setTab(t) { this.tab[this.app.mode] = t; this.refresh(); }

  refresh() {
    const tabs = this.app.mode === 'edit' ? EDIT_TABS : READ_TABS;
    const cur = this.tab[this.app.mode];
    this.tabsEl.textContent = '';
    for (const [id, label] of tabs) this.tabsEl.append(el('button', { class: id === cur ? 'on' : '', onclick: () => this.setTab(id) }, label));
    if (this.thumbIO) { this.thumbIO.disconnect(); this.thumbIO = null; }
    this.body.textContent = '';
    this.body.scrollTop = 0;
    if (!this.doc) { this.body.append(el('div', { class: 'side-hint' }, 'Open a PDF to see its contents.')); return; }
    this.renderedFor = this.doc;
    ({ contents: () => this.renderContents(), pages: () => this.renderThumbs(false), organize: () => this.renderThumbs(true), notes: () => this.renderNotes(), bookmarks: () => this.renderBookmarks(), forms: () => this.app.editor.renderForms(this.body) })[cur]();
  }

  // ---------- contents ----------
  async renderContents() {
    const doc = this.doc;
    const status = el('div', { class: 'side-hint' }, 'Reading contents…');
    this.body.append(status);
    const res = await getOutline(doc, (p) => { status.textContent = `Detecting sections… ${Math.round(p * 100)}%`; });
    if (this.doc !== doc || this.tab[this.app.mode] !== 'contents') return;
    status.remove();
    if (!res.items.length) { this.body.append(el('div', { class: 'side-hint' }, 'No sections found in this document.')); return; }
    if (res.source === 'detected') this.body.append(el('div', { class: 'side-hint' }, 'No bookmarks in this PDF; sections were detected automatically.'));
    const wrap = el('div', { class: 'outline' });
    const build = (items, container, path) => {
      items.forEach((it, idx) => {
        const key = path + '/' + idx;
        const hasKids = it.children.length > 0;
        const coll = this.collapsed.has(key) || (!this.collapsed.has(key + '!open') && it.depth >= 1 && hasKids && countAll(res.items) > 80);
        const tw = el('span', { class: 'tw' }, hasKids ? (coll ? '▸' : '▾') : '');
        const row = el('div', { class: 'item', style: { paddingLeft: (6 + it.depth * 12) + 'px' }, title: it.title },
          tw, el('span', { class: 't' }, it.title), el('span', { class: 'p' }, it.page != null ? String(it.page + 1) : ''));
        row._item = it;
        const kids = el('div', { class: 'children' + (coll ? ' collapsed' : '') });
        tw.addEventListener('click', (e) => {
          e.stopPropagation();
          const c = kids.classList.toggle('collapsed');
          tw.textContent = c ? '▸' : '▾';
          if (c) { this.collapsed.add(key); this.collapsed.delete(key + '!open'); } else { this.collapsed.delete(key); this.collapsed.add(key + '!open'); }
        });
        row.addEventListener('click', () => {
          if (it.url) { window.open(it.url); return; }
          if (it.page != null) this.pane.goto(it.page, { push: true, pdfY: it.y });
        });
        container.append(row);
        if (hasKids) { build(it.children, kids, key); container.append(kids); }
      });
    };
    build(res.items, wrap, '');
    this.body.append(wrap);
    this.outlineRows = Array.from(wrap.querySelectorAll('.item'));
    this.highlightCurrentSection();
  }

  highlightCurrentSection() {
    if (!this.outlineRows || !this.pane || this.renderedFor !== this.doc) return;
    const p = this.pane.current;
    let best = null;
    for (const r of this.outlineRows) {
      const it = r._item;
      if (it.page != null && it.page <= p) best = r;
    }
    for (const r of this.outlineRows) r.classList.toggle('cur', r === best);
    if (best && best.offsetParent) {
      const br = best.getBoundingClientRect(), sr = this.body.getBoundingClientRect();
      if (br.top < sr.top || br.bottom > sr.bottom) best.scrollIntoView({ block: 'nearest' });
    }
  }

  onPaneMoved() {
    const t = this.tab[this.app.mode];
    if (t === 'contents') this.highlightCurrentSection();
    if ((t === 'pages' || t === 'organize') && this.thumbEls) {
      const p = this.pane.current;
      this.thumbEls.forEach((e, i) => e.classList.toggle('cur', i === p));
      const e = this.thumbEls[p];
      if (e) {
        const br = e.getBoundingClientRect(), sr = this.body.getBoundingClientRect();
        if (br.top < sr.top || br.bottom > sr.bottom) e.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  // ---------- thumbnails / organizer ----------
  renderThumbs(organize) {
    const doc = this.doc;
    if (organize) {
      const ed = this.app.editor;
      this.body.append(el('div', { class: 'side-actions' },
        el('button', { onclick: () => ed.pageOp('rotate', this.sel()) }, '↻ Rotate'),
        el('button', { onclick: () => ed.pageOp('delete', this.sel()) }, '✕ Delete'),
        el('button', { onclick: () => ed.pageOp('blank', this.sel()) }, '+ Blank'),
        el('button', { onclick: () => ed.pageOp('insertPdf', this.sel()) }, '+ Insert PDF'),
        el('button', { onclick: () => ed.pageOp('extract', this.sel()) }, '⇪ Extract'),
        el('button', { onclick: () => ed.pageOp('crop', this.sel()) }, '⌗ Crop'),
        el('button', { onclick: () => { this.selectedPages = new Set(doc.sizes.map((_, i) => i)); this.refresh(); } }, 'Select all')
      ));
      this.body.append(el('div', { class: 'side-hint' }, 'Click to select (Shift/Ctrl for many), drag to reorder. Actions apply to selected pages or the current page.'));
    }
    const wrap = el('div', { class: 'thumbs' });
    const TW = 150;
    this.thumbEls = doc.sizes.map((s, i) => {
      const h = Math.round(TW * s.h / s.w);
      const ph = el('div', { class: 'ph', style: { width: TW + 'px', height: h + 'px' } });
      const t = el('div', { class: 'thumb' + (i === this.pane.current ? ' cur' : '') + (organize && this.selectedPages.has(i) ? ' selected' : ''), 'data-page': i }, ph, el('div', { class: 'n' }, String(i + 1)));
      t.addEventListener('click', (e) => {
        if (organize) {
          if (e.shiftKey && this.lastSel != null) { const [a, b] = [Math.min(this.lastSel, i), Math.max(this.lastSel, i)]; for (let k = a; k <= b; k++) this.selectedPages.add(k); }
          else if (e.metaKey || e.ctrlKey) { this.selectedPages.has(i) ? this.selectedPages.delete(i) : this.selectedPages.add(i); }
          else { this.selectedPages = new Set([i]); }
          this.lastSel = i;
          this.thumbEls.forEach((x, k) => x.classList.toggle('selected', this.selectedPages.has(k)));
        }
        this.pane.goto(i, { push: true });
      });
      if (organize) {
        t.draggable = true;
        t.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-page', String(i)); e.dataTransfer.effectAllowed = 'move'; });
        t.addEventListener('dragover', (e) => {
          if (!e.dataTransfer.types.includes('text/x-page')) return;
          e.preventDefault();
          const r = t.getBoundingClientRect();
          const before = e.clientY < r.top + r.height / 2;
          t.classList.toggle('drop-before', before); t.classList.toggle('drop-after', !before);
        });
        t.addEventListener('dragleave', () => t.classList.remove('drop-before', 'drop-after'));
        t.addEventListener('drop', (e) => {
          e.preventDefault();
          const before = t.classList.contains('drop-before');
          t.classList.remove('drop-before', 'drop-after');
          const from = parseInt(e.dataTransfer.getData('text/x-page'), 10);
          if (isNaN(from)) return;
          const moving = this.selectedPages.has(from) ? Array.from(this.selectedPages).sort((a, b) => a - b) : [from];
          this.app.editor.movePages(moving, before ? i : i + 1);
        });
        t.append(el('div', { class: 'ops' },
          el('button', { title: 'Rotate', onclick: (e) => { e.stopPropagation(); this.app.editor.pageOp('rotate', [i]); } }, '↻'),
          el('button', { title: 'Delete', onclick: (e) => { e.stopPropagation(); this.app.editor.pageOp('delete', [i]); } }, '✕')));
      }
      t._ph = ph;
      return t;
    });
    wrap.append(...this.thumbEls);
    this.body.append(wrap);
    this.thumbIO = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const t = e.target;
        if (t._done) continue;
        t._done = true;
        this.renderThumb(doc, +t.dataset.page, t, TW);
      }
    }, { root: this.body, rootMargin: '300px 0px' });
    this.thumbEls.forEach(t => this.thumbIO.observe(t));
    requestAnimationFrame(() => { const c = this.thumbEls[this.pane.current]; if (c) c.scrollIntoView({ block: 'center' }); });
  }

  sel() {
    const s = Array.from(this.selectedPages).filter(i => i < this.doc.numPages).sort((a, b) => a - b);
    return s.length ? s : [this.pane.current];
  }

  async renderThumb(doc, i, t, TW) {
    try {
      const page = doc.proxies[i];
      const vp0 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: (TW / vp0.width) * Math.min(2, window.devicePixelRatio || 1) });
      const c = el('canvas', { class: 'thumbimg' });
      c.width = vp.width; c.height = vp.height;
      c.style.width = TW + 'px'; c.style.height = Math.round(TW * vp0.height / vp0.width) + 'px';
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      if (t._ph.isConnected) t._ph.replaceWith(c);
    } catch (e) { /* ignore */ }
  }

  // ---------- notes & highlights ----------
  renderNotes() {
    const doc = this.doc;
    const items = doc.annotations.filter(a => a.type !== 'ink' || true).slice().sort((a, b) => a.page - b.page || (b.rects?.[0]?.[3] ?? b.y ?? 0) - (a.rects?.[0]?.[3] ?? a.y ?? 0));
    const filter = this.notesFilter || 'all';
    const bar = el('div', { class: 'side-actions' },
      ...[['all', 'All'], ['note', 'Notes'], ['highlight', 'Highlights'], ['ink', 'Drawings']].map(([k, l]) =>
        el('button', { class: filter === k ? 'on' : '', onclick: () => { this.notesFilter = k; this.refresh(); } }, l)),
      el('button', { title: 'Export notes & highlights as Markdown', onclick: () => this.exportMarkdown() }, '⇩ .md'));
    this.body.append(bar);
    const list = el('div', { class: 'list' });
    const shown = items.filter(a => filter === 'all' || (filter === 'highlight' ? ['highlight', 'underline', 'strike'].includes(a.type) : a.type === filter));
    if (!shown.length) list.append(el('div', { class: 'side-hint' }, 'Nothing yet. Use the toolbar to highlight, draw or add notes — they are saved inside the PDF.'));
    for (const a of shown) {
      const label = { highlight: 'Highlight', underline: 'Underline', strike: 'Strike-through', ink: 'Drawing', note: 'Note', freetext: 'Text' }[a.type] || a.type;
      const body = a.type === 'note' || a.type === 'freetext' ? (a.text || '(empty)') : (a.text ? '“' + a.text + '”' : '') + (a.note ? '\n✎ ' + a.note : '');
      const entry = el('div', { class: 'entry', style: { borderLeftColor: rgbToHex(a.color) } },
        el('div', { class: 'meta' }, el('span', {}, label), el('span', {}, 'p. ' + (a.page + 1))),
        body ? el('div', { class: 'txt' }, body) : null);
      entry.addEventListener('click', () => {
        const y = a.rects ? a.rects[0][3] : (a.y ?? (a.paths ? a.paths[0][0][1] : null));
        this.pane.goto(a.page, { push: true, pdfY: y != null ? y + 40 : null });
      });
      list.append(entry);
    }
    this.body.append(list);
  }

  async exportMarkdown() {
    const doc = this.doc;
    const lines = [`# ${doc.name}`, '', `Exported from PDF-Bat — ${new Date().toLocaleString()}`, ''];
    const items = doc.annotations.slice().sort((a, b) => a.page - b.page);
    let lastPage = -1;
    for (const a of items) {
      if (a.type === 'ink') continue;
      if (a.page !== lastPage) { lines.push(`## Page ${a.page + 1}`, ''); lastPage = a.page; }
      if (a.type === 'note' || a.type === 'freetext') lines.push(`- 📝 ${(a.text || '').replace(/\n/g, '\n  ')}`);
      else { lines.push(`- > ${a.text || ''}`); if (a.note) lines.push(`  - ${a.note}`); }
    }
    const bm = doc.meta.bookmarks || [];
    if (bm.length) { lines.push('', '## Bookmarks', ''); for (const b of bm) lines.push(`- ${b.title} (p. ${b.page + 1})`); }
    const p = await window.bat.saveTexDialog(doc.path.replace(/\.pdf$/i, '') + ' — notes.md');
    if (!p) return;
    await window.bat.writeText(p.replace(/\.tex$/i, '.md'), lines.join('\n'));
    toast('Notes exported');
  }

  // ---------- bookmarks ----------
  renderBookmarks() {
    const doc = this.doc;
    const bm = doc.meta.bookmarks || [];
    this.body.append(el('div', { class: 'side-actions' }, el('button', { onclick: () => this.pane.toggleBookmark() }, '🔖 Toggle bookmark on current page')));
    const list = el('div', { class: 'list' });
    if (!bm.length) list.append(el('div', { class: 'side-hint' }, 'No bookmarks yet.'));
    for (const b of bm) {
      const title = el('div', { class: 'txt' }, b.title);
      const entry = el('div', { class: 'entry', style: { borderLeftColor: 'var(--danger)' } },
        el('div', { class: 'meta' }, el('span', {}, 'p. ' + (b.page + 1)), el('span', {},
          el('button', { title: 'Rename', onclick: async (e) => { e.stopPropagation(); const t = await this.app.prompt('Bookmark name', b.title); if (t != null) { b.title = t; doc.setMeta({ bookmarks: bm }); this.refresh(); } } }, '✎'),
          el('button', { title: 'Remove', onclick: (e) => { e.stopPropagation(); doc.setMeta({ bookmarks: bm.filter(x => x !== b) }); this.app.forEachPaneOf(doc, p => p.updateBookmarkFlags()); this.refresh(); } }, '✕'))),
        title);
      entry.addEventListener('click', () => this.pane.goto(b.page, { push: true }));
      list.append(entry);
    }
    this.body.append(list);
  }
}

function countAll(items) { return items.reduce((n, it) => n + 1 + countAll(it.children), 0); }
