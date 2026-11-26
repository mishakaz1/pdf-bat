// A viewer pane: continuous-scroll view of one Doc with its own position and zoom.
import { pdfjsLib, pageText } from './doc.js';
import { el, sv, debounce, clamp, uid, rgbToHex, hexToRgb, toast, nextFrame } from './util.js';
import { bindLinkPreview, smartJump, hidePreview } from './preview.js';

const MAX_CANVAS_PIXELS = 16_000_000;

export class Pane {
  constructor(app, doc, opts = {}) {
    this.app = app;
    this.doc = doc;
    this.id = uid();
    doc.refs++;
    this.zoomMode = opts.zoomMode || 'fitWidth';
    this.scale = opts.scale || 1;
    this.spread = !!opts.spread;
    this.current = 0;
    this.views = [];          // per page {div, rendered, canvas, task, vp, textLayer, ...}
    this.history = [];        // navigation back stack
    this.future = [];
    this.find = null;
    this.ruler = false;
    this.hCenter = true;      // keep pages horizontally centred until the user scrolls sideways
    this._lastLeft = 0;
    this.buildDom();
    this.unsub = [
      doc.on('annotations', (p) => this.refreshOverlays(p)),
      doc.on('edits', (p) => this.refreshEdits(p)),
      doc.on('reload', () => this.reload()),
      doc.on('dirty', () => this.updateHead())
    ];
    this.saveViewState = debounce(() => {
      const off = this.pageOffsetFraction();
      this.doc.setMeta({ lastPage: this.current, lastOffset: off, zoomMode: this.zoomMode, scale: this.scale });
      this.app.saveSession();
    }, 600);
  }

  // ---------- DOM ----------
  buildDom() {
    this.pgInput = el('input', { class: 'pg', title: 'Page' });
    this.countEl = el('span', { class: 'count' });
    this.zoomEl = el('span', { class: 'zoom', title: 'Click: fit width' });
    this.nameEl = el('div', { class: 'name', title: this.doc.path });
    this.head = el('div', { class: 'pane-head' },
      el('button', { class: 'opt2', title: 'Back (Alt+←)', onclick: () => this.back() }, '‹'),
      el('button', { class: 'opt2', title: 'Forward (Alt+→)', onclick: () => this.forward() }, '›'),
      this.nameEl,
      this.pgInput, this.countEl,
      el('button', { class: 'opt2', title: 'Zoom out', onclick: () => this.zoomBy(1 / 1.15) }, '−'),
      this.zoomEl,
      el('button', { class: 'opt2', title: 'Zoom in', onclick: () => this.zoomBy(1.15) }, '+'),
      el('button', { class: 'opt', title: 'Fit page', onclick: () => this.setZoom('fitPage') }, '⤢'),
      el('button', { class: 'opt', title: 'Two-page spread', onclick: () => this.toggleSpread() }, '▯▯'),
      el('button', { class: 'opt', title: 'Bookmark this page (B)', onclick: () => this.toggleBookmark() }, '🔖'),
      el('button', { title: 'Split: same file side by side (Ctrl+J)', onclick: () => this.app.duplicatePane(this) }, '⧉'),
      el('button', { title: 'Close pane (Ctrl+W)', onclick: () => this.app.closePane(this) }, '✕')
    );
    this.zoomEl.addEventListener('click', () => this.setZoom('fitWidth'));
    this.pgInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const n = parseInt(this.pgInput.value, 10);
        if (n >= 1 && n <= this.doc.numPages) this.goto(n - 1, { push: true });
        this.pgInput.blur();
      }
    });
    this.pagesEl = el('div', { class: 'pages' });
    this.scrollEl = el('div', { class: 'pane-scroll', tabindex: '0' }, this.pagesEl);
    this.root = el('div', { class: 'pane' }, this.head, this.scrollEl);
    this.root.addEventListener('mousedown', () => this.app.setActive(this), true);
    this.scrollEl.addEventListener('scroll', () => this.onScroll(), { passive: true });
    this.scrollEl.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        this.zoomBy(Math.exp(-e.deltaY * 0.0025), e);
      }
    }, { passive: false });
    this.scrollEl.addEventListener('mouseup', (e) => this.onMouseUp(e));
    // smart jump: Alt+click or middle-click on "Figure 3", "(2.14)", "Theorem 4" … shows a preview of it
    this.scrollEl.addEventListener('mousedown', (e) => {
      if (e.button === 1 || (e.button === 0 && e.altKey)) {
        if (e.target.closest && e.target.closest('.textLayer span')) {
          e.preventDefault(); e.stopPropagation();
          smartJump(this, e);
        }
      }
    }, true);
    this.scrollEl.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
    this.scrollEl.addEventListener('scroll', () => hidePreview(), { passive: true });
    this.scrollEl.addEventListener('mousemove', (e) => this.onMouseMoveRuler(e));
    this.installHandDrag();
    this.ro = new ResizeObserver(debounce(() => { if (this.zoomMode !== 'custom') this.applyZoom(); this.centerH(); }, 80));
    this.ro.observe(this.scrollEl);
    this.updateHead();
  }

  updateHead() {
    this.nameEl.textContent = this.doc.name;
    this.nameEl.title = this.doc.path;
    this.nameEl.classList.toggle('dirty', this.doc.dirty && this.doc.contentDirty);
    this.countEl.textContent = '/ ' + (this.doc.numPages || 0);
    if (document.activeElement !== this.pgInput) this.pgInput.value = String(this.current + 1);
    this.zoomEl.textContent = Math.round(this.scale * 100) + '%';
  }

  // ---------- layout ----------
  async mount(container, opts = {}) {
    container.append(this.root);
    await nextFrame();
    this.computeScale();
    this.layout();
    const startPage = opts.page != null ? opts.page : (this.doc.meta.lastPage || 0);
    const off = opts.offset != null ? opts.offset : (opts.page != null ? 0 : (this.doc.meta.lastOffset || 0));
    this.goto(clamp(startPage, 0, this.doc.numPages - 1), { offset: off });
    this.updateHead();
  }

  computeScale() {
    const w = this.scrollEl.clientWidth - 40;
    const h = this.scrollEl.clientHeight - 32;
    const sizes = this.doc.sizes;
    const ref = sizes[this.current] || sizes[0];
    const maxW = this.spread ? Math.max(...sizes.slice(0, 50).map(s => s.w)) * 2 + 24 : ref.w;
    if (this.zoomMode === 'fitWidth') this.scale = clamp(w / maxW, 0.1, 8);
    else if (this.zoomMode === 'fitPage') this.scale = clamp(Math.min(w / maxW, h / ref.h), 0.1, 8);
  }

  layout() {
    // (re)build page placeholders
    for (const v of this.views) this.unrender(v);
    this.pagesEl.textContent = '';
    this.pagesEl.classList.toggle('spread', this.spread);
    if (this.io) this.io.disconnect();
    this.io = new IntersectionObserver((entries) => this.onIntersect(entries), { root: this.scrollEl, rootMargin: '120% 0px 120% 0px' });
    this.views = this.doc.sizes.map((s, i) => {
      const div = el('div', { class: 'page', 'data-page': i });
      div.style.width = s.w * this.scale + 'px';
      div.style.height = s.h * this.scale + 'px';
      div.append(el('div', { class: 'page-num' }, String(i + 1)));
      this.pagesEl.append(div);
      const v = { i, div, rendered: false, scale: 0, visible: false };
      this.io.observe(div);
      return v;
    });
    if (this.spread) this.pagesEl.style.maxWidth = (Math.max(...this.doc.sizes.slice(0, 50).map(s => s.w)) * this.scale * 2 + 40) + 'px';
    else this.pagesEl.style.maxWidth = '';
    this.updateBookmarkFlags();
  }

  resizePages() {
    this.views.forEach((v, i) => {
      const s = this.doc.sizes[i];
      v.div.style.width = s.w * this.scale + 'px';
      v.div.style.height = s.h * this.scale + 'px';
    });
    if (this.spread) this.pagesEl.style.maxWidth = (Math.max(...this.doc.sizes.slice(0, 50).map(s => s.w)) * this.scale * 2 + 40) + 'px';
  }

  async reload() {
    const page = Math.min(this.current, this.doc.numPages - 1);
    const off = this.pageOffsetFraction();
    this.computeScale();
    this.layout();
    this.goto(page, { offset: off });
    this.updateHead();
  }

  // ---------- zoom ----------
  setZoom(mode) {
    this.zoomMode = mode;
    this.hCenter = true;
    this.applyZoom();
  }
  zoomBy(f, ev) {
    this.zoomMode = 'custom';
    this.applyZoom(clamp(this.scale * f, 0.1, 8), ev);
  }
  applyZoom(newScale, ev) {
    const old = this.scale;
    const page = this.current;
    const off = this.pageOffsetFraction();
    // horizontal anchor
    let ax = null;
    if (ev && ev.clientX != null) {
      const r = this.scrollEl.getBoundingClientRect();
      ax = { px: ev.clientX - r.left, sx: this.scrollEl.scrollLeft };
    }
    if (newScale) this.scale = newScale; else this.computeScale();
    if (Math.abs(old - this.scale) < 1e-4) { this.updateHead(); return; }
    this.resizePages();
    this.goto(page, { offset: off, noSave: false });
    if (ax && !this.hCenter) { this.scrollEl.scrollLeft = (ax.sx + ax.px) * (this.scale / old) - ax.px; this._lastLeft = this.scrollEl.scrollLeft; }
    this.centerH();
    for (const v of this.views) if (v.rendered) v.stale = true;
    this.renderVisibleSoon();
    this.updateHead();
    this.saveViewState();
  }
  toggleSpread() {
    this.spread = !this.spread;
    const p = this.current;
    this.computeScale();
    this.layout();
    this.goto(p);
    this.updateHead();
  }

  // ---------- navigation ----------
  pageOffsetFraction() {
    const v = this.views[this.current];
    if (!v) return 0;
    const top = this.scrollEl.scrollTop - v.div.offsetTop;
    return clamp(top / v.div.offsetHeight, -0.2, 1);
  }
  goto(i, opts = {}) {
    i = clamp(i | 0, 0, this.doc.numPages - 1);
    if (opts.push) this.pushHistory();
    const v = this.views[i];
    if (!v) return;
    let y = v.div.offsetTop - 12;
    if (opts.offset) y = v.div.offsetTop + opts.offset * v.div.offsetHeight;
    if (opts.pdfY != null) {
      const vp = this.doc.viewport(i, this.scale);
      const [, vy] = vp.convertToViewportPoint(opts.pdfX || 0, opts.pdfY);
      y = v.div.offsetTop + vy - 30;
    }
    this.scrollEl.scrollTop = Math.max(0, y);
    this.centerH();
    this.current = i;
    this.updateHead();
    this.app.onPaneMoved(this);
  }
  pushHistory() {
    this.history.push({ page: this.current, offset: this.pageOffsetFraction() });
    if (this.history.length > 100) this.history.shift();
    this.future = [];
  }
  back() {
    const h = this.history.pop();
    if (!h) return;
    this.future.push({ page: this.current, offset: this.pageOffsetFraction() });
    this.goto(h.page, { offset: h.offset });
  }
  forward() {
    const h = this.future.pop();
    if (!h) return;
    this.history.push({ page: this.current, offset: this.pageOffsetFraction() });
    this.goto(h.page, { offset: h.offset });
  }
  async gotoDest(dest) {
    try {
      const r = await resolveDest(this.doc.pdf, dest);
      if (r) this.goto(r.page, { push: true, pdfY: r.y, pdfX: r.x });
    } catch (e) { console.warn('bad destination', e); }
  }

  centerH() {
    if (!this.hCenter) return;
    const el = this.scrollEl;
    el.scrollLeft = Math.max(0, (el.scrollWidth - el.clientWidth) / 2);
    this._lastLeft = el.scrollLeft;
    this._lastGeo = el.scrollWidth + 'x' + el.clientWidth;
  }

  onScroll() {
    const el = this.scrollEl;
    const left = el.scrollLeft, geo = el.scrollWidth + 'x' + el.clientWidth;
    // a sideways move while the content width is unchanged = the user scrolled horizontally
    if (Math.abs(left - this._lastLeft) > 1 && geo === this._lastGeo) this.hCenter = false;
    else if (geo !== this._lastGeo) this.centerH();
    this._lastLeft = el.scrollLeft;
    this._lastGeo = geo;
    // find the page at 30% of the viewport height
    const probe = this.scrollEl.scrollTop + this.scrollEl.clientHeight * 0.3;
    let lo = 0, hi = this.views.length - 1, best = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = this.views[mid];
      if (v.div.offsetTop <= probe) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (this.spread) {
      // in spread mode offsetTop is shared by row: choose leftmost of row
      while (best > 0 && this.views[best - 1].div.offsetTop === this.views[best].div.offsetTop) best--;
    }
    if (best !== this.current) {
      this.current = best;
      this.updateHead();
      this.app.onPaneMoved(this);
    }
    this.saveViewState();
  }

  // ---------- rendering ----------
  onIntersect(entries) {
    for (const e of entries) {
      const i = +e.target.dataset.page;
      const v = this.views[i];
      if (!v) continue;
      v.visible = e.isIntersecting;
      if (!e.isIntersecting && v.rendered) this.unrender(v);
    }
    this.renderVisibleSoon();
  }
  renderVisibleSoon() {
    if (this._rq) return;
    this._rq = requestAnimationFrame(() => {
      this._rq = null;
      const vis = this.views.filter(v => v.visible && (!v.rendered || v.stale));
      // render pages closest to the current page first
      vis.sort((a, b) => Math.abs(a.i - this.current) - Math.abs(b.i - this.current));
      for (const v of vis.slice(0, 6)) this.renderPage(v);
      if (vis.length > 6) setTimeout(() => this.renderVisibleSoon(), 30);
    });
  }

  unrender(v) {
    if (v.task) { try { v.task.cancel(); } catch (_) {} v.task = null; }
    if (v.textLayerObj) { try { v.textLayerObj.cancel(); } catch (_) {} }
    for (const k of ['canvas', 'textDiv', 'svg', 'links', 'notes', 'editLayer', 'inputLayer']) {
      if (v[k]) { if (v[k].tagName === 'CANVAS') { v[k].width = 0; v[k].height = 0; } v[k].remove(); v[k] = null; }
    }
    v.rendered = false;
    v.stale = false;
    v.rendering = null;
  }

  async renderPage(v) {
    if (v.rendering) return;
    const scale = this.scale;
    const token = {};
    v.rendering = token;
    const page = this.doc.proxies[v.i];
    const vp = page.getViewport({ scale });
    const dpr = window.devicePixelRatio || 1;
    let outScale = dpr;
    const px = vp.width * vp.height * dpr * dpr;
    if (px > MAX_CANVAS_PIXELS) outScale = Math.sqrt(MAX_CANVAS_PIXELS / (vp.width * vp.height));
    const canvas = el('canvas', { class: 'pc' });
    canvas.width = Math.floor(vp.width * outScale);
    canvas.height = Math.floor(vp.height * outScale);
    const ctx = canvas.getContext('2d', { alpha: false });
    const task = page.render({
      canvasContext: ctx, viewport: vp,
      transform: outScale !== 1 ? [outScale, 0, 0, outScale, 0, 0] : null,
      annotationMode: pdfjsLib.AnnotationMode.ENABLE
    });
    if (v.task) { try { v.task.cancel(); } catch (_) {} }
    v.task = task;
    try { await task.promise; } catch (e) {
      if (e && e.name === 'RenderingCancelledException') { if (v.rendering === token) v.rendering = null; return; }
      console.warn('render error', e);
    }
    if (v.rendering !== token) return;
    v.task = null;
    // swap in the new canvas (keeps old one visible until the new one is ready → no flicker on zoom)
    if (v.canvas) { v.canvas.width = 0; v.canvas.remove(); }
    v.div.prepend(canvas);
    v.canvas = canvas;
    v.vp = vp;
    v.scale = scale;
    v.div.style.setProperty('--scale-factor', String(scale));
    v.div.style.setProperty('--total-scale-factor', String(scale));
    v.rendered = true;
    v.stale = false;
    v.rendering = null;
    await this.renderTextLayer(v, page, vp);
    this.renderLinks(v, page, vp);
    this.renderOverlays(v);
    this.renderEditLayer(v);
    this.ensureInputLayer(v);
  }

  async renderTextLayer(v, page, vp) {
    if (v.textDiv) v.textDiv.remove();
    const div = el('div', { class: 'textLayer' });
    v.div.append(div);
    v.textDiv = div;
    try {
      const tc = await pageText(this.doc, v.i);
      const tl = new pdfjsLib.TextLayer({ textContentSource: tc, container: div, viewport: vp });
      v.textLayerObj = tl;
      await tl.render();
      div.append(el('div', { class: 'endOfContent' }));
      if (this.find && this.find.q) this.markFind(v);
    } catch (e) { if (!/cancel/i.test(String(e))) console.warn('text layer', e); }
  }

  async renderLinks(v, page, vp) {
    if (v.links) v.links.remove();
    const layer = el('div', { class: 'links' });
    v.links = layer;
    v.div.append(layer);
    let annots = [];
    try { annots = await page.getAnnotations({ intent: 'display' }); } catch (_) {}
    for (const a of annots) {
      if (a.subtype !== 'Link') continue;
      const r = pdfjsLib.Util.normalizeRect(vp.convertToViewportRectangle(a.rect));
      const link = el('a', { style: { left: r[0] + 'px', top: r[1] + 'px', width: (r[2] - r[0]) + 'px', height: (r[3] - r[1]) + 'px' } });
      if (a.url || a.unsafeUrl) {
        const url = a.url || a.unsafeUrl;
        link.title = url;
        link.addEventListener('click', (e) => { e.preventDefault(); if (/^(https?|mailto):/i.test(url)) window.open(url); });
      } else if (a.dest) {
        link.addEventListener('click', (e) => { e.preventDefault(); this.gotoDest(a.dest); });
        bindLinkPreview(this, link, () => resolveDest(this.doc.pdf, a.dest).catch(() => null));
      } else continue;
      layer.append(link);
    }
  }

  ensureInputLayer(v) {
    if (v.inputLayer) return;
    const layer = el('div', { class: 'inputLayer' });
    v.inputLayer = layer;
    v.div.append(layer);
    layer.addEventListener('pointerdown', (e) => this.onInputPointerDown(v, e));
  }

  refreshOverlays(page) {
    for (const v of this.views) if (v.rendered && (page == null || v.i === page)) this.renderOverlays(v);
  }
  refreshEdits(page) {
    for (const v of this.views) if (v.rendered && (page == null || v.i === page)) this.renderEditLayer(v);
  }
  renderEditLayer(v) {
    if (!v.editLayer) {
      v.editLayer = el('div', { class: 'editLayer' });
      v.div.append(v.editLayer);
    }
    this.app.editor.renderLayer(this, v);
  }

  // annotations drawn as SVG (highlights, ink) + HTML (notes)
  renderOverlays(v) {
    if (!v.vp) return;
    const vp = v.vp;
    if (v.svg) v.svg.remove();
    if (v.notes) v.notes.remove();
    const svg = sv('svg', { class: 'anno', width: vp.width, height: vp.height, viewBox: `0 0 ${vp.width} ${vp.height}` });
    const notes = el('div', { class: 'notes' });
    v.svg = svg; v.notes = notes;
    const s = vp.scale;
    for (const a of this.doc.annotations) {
      if (a.page !== v.i) continue;
      const color = rgbToHex(a.color);
      if (a.type === 'highlight' || a.type === 'underline' || a.type === 'strike') {
        const g = sv('g', { 'data-id': a.id });
        for (const r of a.rects) {
          const vr = pdfjsLib.Util.normalizeRect(vp.convertToViewportRectangle(r));
          const h = vr[3] - vr[1];
          if (a.type === 'highlight') {
            g.append(sv('rect', { x: vr[0], y: vr[1], width: vr[2] - vr[0], height: h, fill: color, 'fill-opacity': a.opacity ?? 0.4, style: 'mix-blend-mode:multiply', class: 'hit' }));
          } else {
            const y = a.type === 'underline' ? vr[3] - h * 0.08 : vr[1] + h * 0.55;
            g.append(sv('line', { x1: vr[0], x2: vr[2], y1: y, y2: y, stroke: color, 'stroke-width': Math.max(1, h * 0.07), class: 'hit' }));
          }
        }
        if (a.note) {
          const vr = pdfjsLib.Util.normalizeRect(vp.convertToViewportRectangle(a.rects[0]));
          const pin = el('div', { class: 'note-pin', title: a.note, style: { left: (vr[0] - 6) + 'px', top: (vr[1] + 2) + 'px', width: '12px', height: '12px', background: color, fontSize: '8px' } }, '');
          pin.addEventListener('click', (e) => { e.stopPropagation(); this.openAnnoPopup(a, e.clientX, e.clientY); });
          notes.append(pin);
        }
        svg.append(g);
      } else if (a.type === 'ink') {
        const g = sv('g', { 'data-id': a.id });
        for (const path of a.paths) {
          const d = pathD(path.map(p => vp.convertToViewportPoint(p[0], p[1])));
          g.append(sv('path', { d, fill: 'none', stroke: color, 'stroke-width': (a.width || 1.5) * s, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-opacity': a.opacity ?? 1, class: 'hit', style: (a.opacity ?? 1) < 1 ? 'mix-blend-mode:multiply' : '' }));
        }
        svg.append(g);
      } else if (a.type === 'note') {
        const [x, y] = vp.convertToViewportPoint(a.x, a.y);
        const pin = el('div', { class: 'note-pin', title: a.text || 'Note', style: { left: (x + 11) + 'px', top: (y + 11) + 'px', background: color } }, '✎');
        pin.addEventListener('mousedown', (e) => e.stopPropagation());
        pin.addEventListener('click', (e) => { e.stopPropagation(); this.openNotePopup(v, a); });
        notes.append(pin);
      } else if (a.type === 'freetext') {
        const r = pdfjsLib.Util.normalizeRect(vp.convertToViewportRectangle(a.rect));
        notes.append(el('div', { style: { position: 'absolute', left: r[0] + 'px', top: r[1] + 'px', width: (r[2] - r[0]) + 'px', fontSize: (a.size || 12) * s + 'px', color, whiteSpace: 'pre-wrap', pointerEvents: 'none' } }, a.text));
      }
    }
    // live stroke container
    v.live = sv('g');
    svg.append(v.live);
    const after = v.textDiv ? v.textDiv.nextSibling : null;
    v.div.insertBefore(svg, after);
    v.div.append(notes);
    if (this.find && this.find.q) this.markFind(v);
  }

  // ---------- pointer tools ----------
  pageOfClient(x, y) {
    for (const v of this.views) {
      if (!v.rendered) continue;
      const r = v.div.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return { v, lx: x - r.left, ly: y - r.top };
    }
    return null;
  }

  onInputPointerDown(v, e) {
    const tool = this.app.tool;
    if (e.button !== 0) return;
    const rect = v.div.getBoundingClientRect();
    const local = (ev) => [ev.clientX - rect.left, ev.clientY - rect.top];
    if (this.app.mode === 'edit' && this.app.editor.handlesTool(tool)) {
      this.app.editor.pointerDown(this, v, e, local);
      return;
    }
    if (tool === 'pen' || tool === 'marker') {
      e.preventDefault();
      v.inputLayer.setPointerCapture(e.pointerId);
      const pts = [local(e)];
      const opts = this.app.penOptions(tool);
      const path = sv('path', { fill: 'none', stroke: opts.color, 'stroke-width': opts.width * v.vp.scale, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-opacity': opts.opacity, style: opts.opacity < 1 ? 'mix-blend-mode:multiply' : '' });
      v.live.append(path);
      const straight = () => e.shiftKey;
      const move = (ev) => {
        const evs = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
        for (const ce of evs) pts.push(local(ce));
        const shown = ev.shiftKey ? [pts[0], pts[pts.length - 1]] : pts;
        path.setAttribute('d', pathD(shown));
      };
      const up = (ev) => {
        v.inputLayer.removeEventListener('pointermove', move);
        v.inputLayer.removeEventListener('pointerup', up);
        v.inputLayer.removeEventListener('pointercancel', up);
        path.remove();
        let final = ev.shiftKey || straight() ? [pts[0], pts[pts.length - 1]] : simplify(pts, 0.6);
        const pdfPts = final.map(([x, y]) => v.vp.convertToPdfPoint(x, y).map(n => Math.round(n * 100) / 100));
        this.doc.addAnnotation({ type: 'ink', page: v.i, paths: [pdfPts], color: hexToRgb(opts.color), width: opts.width, opacity: opts.opacity });
      };
      v.inputLayer.addEventListener('pointermove', move);
      v.inputLayer.addEventListener('pointerup', up);
      v.inputLayer.addEventListener('pointercancel', up);
    } else if (tool === 'eraser') {
      e.preventDefault();
      v.inputLayer.setPointerCapture(e.pointerId);
      const erase = (ev) => {
        const [x, y] = local(ev);
        const [px, py] = v.vp.convertToPdfPoint(x, y);
        const tol = 6 / v.vp.scale;
        const hit = hitTest(this.doc.annotations, v.i, px, py, tol);
        if (hit) this.doc.removeAnnotation(hit.id);
      };
      erase(e);
      const up = () => { v.inputLayer.removeEventListener('pointermove', erase); v.inputLayer.removeEventListener('pointerup', up); };
      v.inputLayer.addEventListener('pointermove', erase);
      v.inputLayer.addEventListener('pointerup', up);
    } else if (tool === 'note') {
      e.preventDefault();
      const [x, y] = local(e);
      const [px, py] = v.vp.convertToPdfPoint(x - 11, y - 11);
      const a = this.doc.addAnnotation({ type: 'note', page: v.i, x: px, y: py, text: '', color: hexToRgb(this.app.noteColor) });
      setTimeout(() => this.openNotePopup(this.views[v.i], a, true), 30);
    } else if (tool === 'snap') {
      e.preventDefault();
      this.dragRect(v, e, local, async (r) => {
        if (r.w < 4 || r.h < 4) return;
        await this.app.snapshot(this, v, r);
      });
    }
  }

  // Generic rubber-band rectangle on a page. cb({x,y,w,h}) in page-local css px.
  dragRect(v, e, local, cb, cls = 'drag-rect') {
    v.inputLayer.setPointerCapture(e.pointerId);
    const [sx, sy] = local(e);
    const box = el('div', { class: cls });
    v.div.append(box);
    const upd = (ev) => {
      const [x, y] = local(ev);
      const r = { x: Math.min(sx, x), y: Math.min(sy, y), w: Math.abs(x - sx), h: Math.abs(y - sy) };
      Object.assign(box.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
      return r;
    };
    upd(e);
    const up = (ev) => {
      v.inputLayer.removeEventListener('pointermove', upd);
      v.inputLayer.removeEventListener('pointerup', up);
      const r = upd(ev);
      box.remove();
      cb(r);
    };
    v.inputLayer.addEventListener('pointermove', upd);
    v.inputLayer.addEventListener('pointerup', up);
  }

  installHandDrag() {
    let drag = null;
    this.scrollEl.addEventListener('pointerdown', (e) => {
      if (this.app.tool !== 'hand' || e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, l: this.scrollEl.scrollLeft, t: this.scrollEl.scrollTop };
      this.scrollEl.setPointerCapture(e.pointerId);
      this.scrollEl.style.cursor = 'grabbing';
    });
    this.scrollEl.addEventListener('pointermove', (e) => {
      if (!drag) return;
      this.scrollEl.scrollLeft = drag.l - (e.clientX - drag.x);
      this.scrollEl.scrollTop = drag.t - (e.clientY - drag.y);
    });
    const end = () => { drag = null; this.scrollEl.style.cursor = ''; };
    this.scrollEl.addEventListener('pointerup', end);
    this.scrollEl.addEventListener('pointercancel', end);
  }

  // text selection → highlight etc.
  onMouseUp(e) {
    if (this.app.mode === 'edit' && this.app.tool === 'edittext') return;
    const tool = this.app.tool;
    const sel = window.getSelection();
    const hasSel = sel && !sel.isCollapsed && this.root.contains(sel.anchorNode);
    if (hasSel) {
      if (tool === 'highlight' || tool === 'underline' || tool === 'strike') {
        this.annotateSelection(tool, this.app.highlightColor);
        sel.removeAllRanges();
      } else if (tool === 'select') {
        this.app.showSelectionPopup(this, e.clientX, e.clientY);
      }
      return;
    }
    if (tool === 'select' || tool === 'highlight' || tool === 'underline' || tool === 'strike') {
      // click on an existing highlight → popup
      const hit = this.pageOfClient(e.clientX, e.clientY);
      if (!hit) return;
      const [px, py] = hit.v.vp.convertToPdfPoint(hit.lx, hit.ly);
      const a = hitTest(this.doc.annotations, hit.v.i, px, py, 2 / hit.v.vp.scale, true);
      if (a) this.openAnnoPopup(a, e.clientX, e.clientY);
    }
  }

  selectionRects() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return null;
    const byPage = new Map();
    let text = sel.toString().replace(/\s+/g, ' ').trim();
    for (let k = 0; k < sel.rangeCount; k++) {
      const range = sel.getRangeAt(k);
      for (const cr of range.getClientRects()) {
        if (cr.width < 1 || cr.height < 1) continue;
        const cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
        const hit = this.pageOfClient(cx, cy);
        if (!hit) continue;
        const pr = hit.v.div.getBoundingClientRect();
        if (cr.height > pr.height * 0.3) continue; // skip bogus full-page rects
        const x1 = cr.left - pr.left, y1 = cr.top - pr.top, x2 = cr.right - pr.left, y2 = cr.bottom - pr.top;
        const vp = hit.v.vp;
        const a = vp.convertToPdfPoint(x1, y1), b = vp.convertToPdfPoint(x2, y2);
        const r = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
        if (!byPage.has(hit.v.i)) byPage.set(hit.v.i, []);
        byPage.get(hit.v.i).push(r);
      }
    }
    for (const [p, rs] of byPage) byPage.set(p, mergeLineRects(rs));
    return { byPage, text };
  }

  annotateSelection(type, colorHex, note) {
    const r = this.selectionRects();
    if (!r || !r.byPage.size) return null;
    let first = null;
    for (const [page, rects] of r.byPage) {
      if (!rects.length) continue;
      const a = this.doc.addAnnotation({ type, page, rects, color: hexToRgb(colorHex), opacity: type === 'highlight' ? 0.4 : 1, text: r.text, note: note || '' });
      first ||= a;
    }
    return first;
  }

  openNotePopup(v, a, isNew) {
    this.app.closePopups();
    if (!v || !v.vp) return;
    const [x, y] = v.vp.convertToViewportPoint(a.x, a.y);
    const ta = el('textarea', { placeholder: 'Note…' });
    ta.value = a.text || '';
    const pop = el('div', { class: 'note-pop', style: { left: Math.min(x + 26, v.div.clientWidth - 250) + 'px', top: (y + 4) + 'px' } },
      ta,
      el('div', { class: 'row' },
        el('span', { class: 'spacer', style: { color: 'var(--fg3)', fontSize: '11px', alignSelf: 'center' } }, 'p. ' + (a.page + 1)),
        el('button', { onclick: () => { this.doc.removeAnnotation(a.id); pop.remove(); } }, 'Delete'),
        el('button', { onclick: () => close() }, 'Done'))
    );
    const close = () => {
      if (!pop.isConnected) return;
      const t = ta.value;
      pop.remove();
      if (isNew && !t.trim()) { this.doc.removeAnnotation(a.id); return; }
      if (t !== a.text) this.doc.updateAnnotation(a.id, { text: t });
    };
    pop.addEventListener('mousedown', (e) => e.stopPropagation());
    pop.addEventListener('pointerdown', (e) => e.stopPropagation());
    ta.addEventListener('keydown', (e) => { if (e.key === 'Escape' || (e.key === 'Enter' && (e.metaKey || e.ctrlKey))) { e.preventDefault(); close(); } e.stopPropagation(); });
    v.div.append(pop);
    this.app.popupCloser = close;
    setTimeout(() => ta.focus(), 0);
  }

  openAnnoPopup(a, cx, cy) {
    this.app.openAnnoPopup(this, a, cx, cy);
  }

  // ---------- reading ruler ----------
  setRuler(on) {
    this.ruler = on;
    if (!on && this.rulerEl) { this.rulerEl.remove(); this.rulerEl = null; }
  }
  onMouseMoveRuler(e) {
    if (!this.ruler) return;
    if (!this.rulerEl) { this.rulerEl = el('div', { class: 'reading-ruler' }); this.pagesEl.append(this.rulerEl); this.pagesEl.style.position = 'relative'; }
    const r = this.pagesEl.getBoundingClientRect();
    this.rulerEl.style.top = (e.clientY - r.top - 14) + 'px';
  }

  // ---------- bookmarks ----------
  toggleBookmark() {
    const bm = (this.doc.meta.bookmarks || []).slice();
    const i = bm.findIndex(b => b.page === this.current);
    if (i >= 0) { bm.splice(i, 1); toast('Bookmark removed'); }
    else { bm.push({ page: this.current, title: 'Page ' + (this.current + 1), created: Date.now() }); toast('Bookmarked page ' + (this.current + 1)); }
    bm.sort((a, b) => a.page - b.page);
    this.doc.setMeta({ bookmarks: bm });
    this.app.forEachPaneOf(this.doc, p => p.updateBookmarkFlags());
    this.app.sidebar.refresh();
  }
  updateBookmarkFlags() {
    const set = new Set((this.doc.meta.bookmarks || []).map(b => b.page));
    this.views.forEach(v => {
      const has = set.has(v.i);
      let f = v.div.querySelector('.bookmark-flag');
      if (has && !f) v.div.append(el('div', { class: 'bookmark-flag' }));
      if (!has && f) f.remove();
    });
  }

  // ---------- find ----------
  async runFind(q, dir = 1) {
    q = (q || '').trim();
    if (!q) { this.find = null; this.clearFindMarks(); return { total: 0 }; }
    const ql = q.toLowerCase();
    if (!this.find || this.find.q !== q) {
      this.find = { q, ql, pages: [], idx: -1, done: false };
      const f = this.find;
      // search pages in order, starting from the current one, streaming results
      const n = this.doc.numPages;
      const order = [];
      for (let k = 0; k < n; k++) order.push(k);
      f.counting = (async () => {
        for (const i of order) {
          if (this.find !== f) return;
          const tc = await pageText(this.doc, i);
          const s = tc.items.map(it => it.str + (it.hasEOL ? ' ' : '')).join('').toLowerCase();
          let c = 0, pos = s.indexOf(ql);
          while (pos >= 0) { c++; pos = s.indexOf(ql, pos + ql.length); }
          for (let m = 0; m < c; m++) f.pages.push({ page: i, k: m });
          if (i % 25 === 0) this.app.onFindProgress(this);
        }
        f.done = true;
        this.app.onFindProgress(this);
      })();
      this.refreshFindMarks();
      // jump to first hit at/after current page
      await waitFor(() => f.done || f.pages.some(h => h.page >= this.current), 15000);
      let start = f.pages.findIndex(h => h.page >= this.current);
      if (start < 0) { await f.counting; start = 0; }
      f.idx = start - 1;
    }
    const f = this.find;
    if (!f.pages.length) { await f.counting; if (!f.pages.length) return { total: 0, done: f.done }; }
    f.idx = (f.idx + dir + f.pages.length) % f.pages.length;
    const h = f.pages[f.idx];
    if (h.page !== this.current || !this.views[h.page].rendered) this.goto(h.page, { push: false });
    setTimeout(() => this.refreshFindMarks(), 60);
    return { total: f.pages.length, idx: f.idx, done: f.done };
  }
  clearFindMarks() {
    for (const v of this.views) if (v.textDiv) unmark(v.textDiv);
  }
  refreshFindMarks() { for (const v of this.views) if (v.rendered) this.markFind(v); }
  markFind(v) {
    if (!v.textDiv) return;
    unmark(v.textDiv);
    if (!this.find || !this.find.q) return;
    const ql = this.find.ql;
    const cur = this.find.pages[this.find.idx];
    let k = 0;
    for (const span of v.textDiv.querySelectorAll('span')) {
      if (span.classList.contains('hit-mark')) continue;
      const t = span.textContent;
      const tl = t.toLowerCase();
      if (!tl.includes(ql)) continue;
      const frag = document.createDocumentFragment();
      let last = 0, pos = tl.indexOf(ql);
      while (pos >= 0) {
        frag.append(t.slice(last, pos));
        const m = el('span', { class: 'hit-mark' }, t.slice(pos, pos + ql.length));
        if (cur && cur.page === v.i && cur.k === k) {
          m.classList.add('cur');
          requestAnimationFrame(() => {
            const r = m.getBoundingClientRect(), sr = this.scrollEl.getBoundingClientRect();
            if (r.top < sr.top + 40 || r.bottom > sr.bottom - 40) this.scrollEl.scrollTop += r.top - sr.top - sr.height / 3;
          });
        }
        k++;
        frag.append(m);
        last = pos + ql.length;
        pos = tl.indexOf(ql, last);
      }
      frag.append(t.slice(last));
      span.textContent = '';
      span.append(frag);
    }
  }

  destroy() {
    this.saveViewState.flush();
    this.unsub.forEach(u => u());
    if (this.io) this.io.disconnect();
    this.ro.disconnect();
    for (const v of this.views) this.unrender(v);
    this.root.remove();
    this.doc.release();
  }
}

// ---------- helpers ----------
function unmark(div) {
  for (const m of div.querySelectorAll('.hit-mark')) {
    const p = m.parentNode;
    m.replaceWith(document.createTextNode(m.textContent));
    p.normalize();
  }
}
async function waitFor(fn, ms) {
  const t0 = performance.now();
  while (!fn() && performance.now() - t0 < ms) await new Promise(r => setTimeout(r, 30));
}

export async function resolveDest(pdf, dest) {
  let d = dest;
  if (typeof d === 'string') d = await pdf.getDestination(d);
  if (!Array.isArray(d)) return null;
  const ref = d[0];
  let page;
  if (typeof ref === 'number') page = ref;
  else if (ref && typeof ref === 'object') page = await pdf.getPageIndex(ref);
  else return null;
  const kind = d[1] && d[1].name;
  let x = null, y = null;
  if (kind === 'XYZ') { x = d[2]; y = d[3]; }
  else if (kind === 'FitH' || kind === 'FitBH') y = d[2];
  else if (kind === 'FitR') { x = d[2]; y = d[5]; }
  return { page, x: x ?? 0, y: y ?? null };
}

export function pathD(pts) {
  if (!pts.length) return '';
  if (pts.length === 1) return `M${pts[0][0]} ${pts[0][1]}l0.01 0`;
  if (pts.length === 2) return `M${pts[0][0]} ${pts[0][1]}L${pts[1][0]} ${pts[1][1]}`;
  let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += `Q${pts[i][0].toFixed(2)} ${pts[i][1].toFixed(2)} ${mx.toFixed(2)} ${my.toFixed(2)}`;
  }
  const l = pts[pts.length - 1];
  d += `L${l[0].toFixed(2)} ${l[1].toFixed(2)}`;
  return d;
}

// Ramer–Douglas–Peucker
export function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0, idx = -1;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function mergeLineRects(rects) {
  rects.sort((a, b) => (b[3] - a[3]) || (a[0] - b[0]));
  const out = [];
  for (const r of rects) {
    const last = out[out.length - 1];
    if (last) {
      const ov = Math.min(last[3], r[3]) - Math.max(last[1], r[1]);
      const hMin = Math.min(last[3] - last[1], r[3] - r[1]);
      if (ov > hMin * 0.5 && r[0] <= last[2] + (r[3] - r[1]) * 0.6) {
        last[0] = Math.min(last[0], r[0]); last[1] = Math.min(last[1], r[1]);
        last[2] = Math.max(last[2], r[2]); last[3] = Math.max(last[3], r[3]);
        continue;
      }
    }
    out.push(r.slice());
  }
  return out.map(r => r.map(n => Math.round(n * 100) / 100));
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function hitTest(annots, page, px, py, tol, markupOnly = false) {
  for (let k = annots.length - 1; k >= 0; k--) {
    const a = annots[k];
    if (a.page !== page) continue;
    if (a.type === 'highlight' || a.type === 'underline' || a.type === 'strike') {
      for (const r of a.rects) if (px >= r[0] - tol && px <= r[2] + tol && py >= r[1] - tol && py <= r[3] + tol) return a;
    } else if (a.type === 'ink' && !markupOnly) {
      const w = (a.width || 1.5) / 2 + tol;
      for (const path of a.paths) {
        if (path.length === 1 && Math.hypot(px - path[0][0], py - path[0][1]) < w) return a;
        for (let i = 1; i < path.length; i++) if (distToSeg(px, py, path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]) < w) return a;
      }
    }
  }
  return null;
}
