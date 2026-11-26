// LaTeX support. This module is imported lazily, only when Edit mode needs it.
//  * full documents: source editor + compiled PDF preview side by side
//  * LaTeX fragments (formulas, text, TikZ…) placed onto existing PDF pages as vector graphics
import { el, modal, toast, debounce, uid, hexToRgb, rgbToHex } from './util.js';
import { Doc, loadPdfjs } from './doc.js';
import { snippetSource, DOC_TEMPLATES, hasNonAscii } from './tex-templates.mjs';

export function init(app) { return new Latex(app); }

class Latex {
  constructor(app) {
    this.app = app;
    this.engines = null;
    app.emitTexProgress = (g, t) => this.onProgress && this.onProgress(g, t);
  }

  get settings() { return this.app.settings; }

  async listEngines(refresh) {
    if (!this.engines || refresh) this.engines = await window.bat.texEngines();
    return this.engines;
  }

  // Returns the engine to use, offering to install Tectonic if none is found.
  async engine() {
    const list = await this.listEngines();
    if (list.length) {
      const pref = this.settings.texEngine;
      return list.find(e => e.id === pref) || list.find(e => e.kind === 'tectonic') || list.find(e => e.id === 'xelatex') || list[0];
    }
    const bar = el('div', { class: 'progress' }, el('div'));
    const status = el('div', { style: { color: 'var(--fg3)', marginTop: '6px', fontSize: '12px' } });
    const m = modal('Set up LaTeX', [
      el('p', {}, 'PDF-Bat compiles LaTeX with ', el('b', {}, 'Tectonic'), ', a complete self-contained TeX engine (~30 MB). It downloads LaTeX packages automatically the first time they are used, so the first compile needs internet and takes longer.'),
      el('p', { style: { color: 'var(--fg2)' } }, 'If you install MacTeX / MiKTeX / TeX Live later, PDF-Bat will find it automatically and you can switch engines in the LaTeX pane.'),
      bar, status
    ], [
      { label: 'Download Tectonic', primary: true, action: async () => {
        status.textContent = 'Downloading…';
        this.onProgress = (g, t) => { bar.firstChild.style.width = (t ? (100 * g / t) : 50) + '%'; status.textContent = `Downloading… ${(g / 1e6).toFixed(1)} MB`; };
        const r = await window.bat.texInstall();
        this.onProgress = null;
        if (!r.ok) { status.textContent = 'Download failed: ' + r.error; return false; }
        return true;
      } },
      { label: 'Cancel', value: null }
    ]);
    if (!(await m.done)) return null;
    const after = await this.listEngines(true);
    toast('LaTeX engine ready');
    return after[0] || null;
  }

  async compile(source, opts = {}) {
    const { engine: given, ...rest } = opts;
    const eng = given || await this.engine();
    if (!eng) return null;
    const r = await window.bat.texCompile(source, Object.assign({}, rest, { engine: eng.path, kind: eng.kind }));
    r.engine = eng;
    return r;
  }

  // ======================= fragments on pages =======================
  async snippet(pane, opts) {
    const eng = await this.engine();
    if (!eng) return;
    const existing = opts.edit || null;
    const s = this.settings;
    const src = el('textarea', { class: 'code', spellcheck: 'false', placeholder: 'e.g.  \\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt\\pi}{2}' });
    src.value = existing ? existing.src : (s.lastSnippet || '');
    const mode = el('select', {}, el('option', { value: 'math' }, 'Formula (math mode)'), el('option', { value: 'text' }, 'Text with $…$ math, TikZ, tables…'));
    mode.value = existing ? existing.mode : (s.snippetMode || 'math');
    const size = el('input', { type: 'number', min: 5, max: 72, step: 0.5, value: existing ? existing.size : (s.snippetSize || 12), style: { width: '64px' } });
    const color = el('input', { type: 'color', value: existing ? existing.color : (s.snippetColor || '#000000'), style: { width: '40px', padding: '0 2px' } });
    const width = el('input', { type: 'number', min: 0, step: 10, value: existing ? (existing.width || 0) : (s.snippetWidth || 0), style: { width: '70px' }, title: 'Line width in pt for text mode (0 = natural width)' });
    const pre = el('textarea', { class: 'code', spellcheck: 'false', style: { minHeight: '70px' }, placeholder: '% your macros, e.g. \\usepackage{physics}  \\newcommand{\\vb}[1]{\\mathbf{#1}}' });
    pre.value = s.snippetPreamble || '';
    const preWrap = el('details', {}, el('summary', { style: { cursor: 'pointer', color: 'var(--fg2)', marginTop: '8px' } }, 'Preamble (packages & macros, remembered)'), pre);
    const preview = el('div', { class: 'preview' }, el('span', { style: { color: '#888' } }, 'Preview appears here'));
    const log = el('pre', { class: 'log', style: { display: 'none' } });
    const status = el('span', { style: { color: 'var(--fg3)', fontSize: '12px' } }, eng.name);
    let last = null, seq = 0;
    const build = async () => {
      if (!src.value.trim()) return null;
      const my = ++seq;
      status.textContent = 'Compiling…';
      const source = snippetSource({ body: src.value, mode: mode.value, size: +size.value, color: color.value, width: mode.value === 'text' ? +width.value : 0, preamble: pre.value, kind: eng.kind });
      const r = await this.compile(source, { engine: eng });
      if (my !== seq) return last;
      if (!r || !r.ok) {
        status.textContent = 'Error';
        log.style.display = 'block';
        log.textContent = extractErrors(r ? r.log : 'No engine') || (r ? r.log.slice(-1500) : '');
        last = null;
        return null;
      }
      log.style.display = 'none';
      status.textContent = eng.name;
      const pdfBytes = new Uint8Array(r.data);
      const shot = await renderFirstPage(pdfBytes, 3);
      preview.textContent = '';
      const img = el('img', { src: shot.url, style: { width: Math.min(shot.w * 1.5, 560) + 'px', maxWidth: '100%' } });
      preview.append(img);
      last = { pdf: pdfBytes, w: shot.w, h: shot.h, url: shot.url, source };
      return last;
    };
    const rebuild = debounce(build, 700);
    for (const i of [src, pre]) i.addEventListener('input', rebuild);
    for (const i of [mode, size, color, width]) i.addEventListener('change', rebuild);
    src.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') { e.preventDefault(); insertAtCursor(src, '  '); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); m.foot.querySelector('.primary').click(); }
    });
    const m = modal(existing ? 'Edit LaTeX' : 'Insert LaTeX', [
      el('div', { style: { width: 'min(640px, 86vw)' } },
        el('label', {}, 'LaTeX'), src,
        el('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap', marginTop: '8px' } },
          mode, el('span', {}, 'Size'), size, el('span', {}, 'pt'), color, el('span', { title: 'Text mode only' }, 'Width'), width, el('span', {}, 'pt')),
        preWrap, preview, log)
    ], [
      { spacer: true, node: status },
      { label: existing ? 'Update' : 'Insert', primary: true, action: async () => {
        const r = (last && last.source === snippetSource({ body: src.value, mode: mode.value, size: +size.value, color: color.value, width: mode.value === 'text' ? +width.value : 0, preamble: pre.value, kind: eng.kind })) ? last : await build();
        if (!r) { toast('Fix the LaTeX errors first'); return false; }
        return r;
      } },
      { label: 'Cancel', value: null }
    ]);
    setTimeout(() => { src.focus(); if (src.value) build(); }, 30);
    const res = await m.done;
    this.app.setSettings({ snippetPreamble: pre.value, snippetMode: mode.value, snippetSize: +size.value, snippetColor: color.value, snippetWidth: +width.value, lastSnippet: existing ? s.lastSnippet : src.value });
    if (!res) return;
    const common = { src: src.value, mode: mode.value, size: +size.value, color: color.value, width: +width.value, pdf: res.pdf, previewUrl: res.url };
    if (existing) {
      // keep the top-left corner and the current scale factor
      const k = existing.scaleFactor || 1;
      const r0 = existing.rect;
      pane.doc.updateEdit(existing.id, Object.assign(common, { baseWidth: res.w, rect: [r0[0], r0[3] - res.h * k, r0[0] + res.w * k, r0[3]] }), true);
    } else {
      const e = pane.doc.addEdit(Object.assign({ type: 'latex', page: opts.page, baseWidth: res.w, scaleFactor: 1, rect: [opts.x, opts.y - res.h, opts.x + res.w, opts.y] }, common));
      this.app.editor.select(pane, e.id);
      this.app.setTool('eselect');
    }
  }

  // ======================= full documents =======================
  async newDocument() {
    const eng = await this.engine();
    if (!eng) return;
    const sel = el('div', { class: 'list' });
    let chosen = 'article';
    const rows = DOC_TEMPLATES.map(t => {
      const r = el('div', { class: 'entry' + (t.id === chosen ? ' on' : ''), style: { borderLeftColor: t.id === chosen ? 'var(--accent)' : 'transparent' } }, t.name);
      r.addEventListener('click', () => { chosen = t.id; rows.forEach((x, i) => { x.style.borderLeftColor = DOC_TEMPLATES[i].id === chosen ? 'var(--accent)' : 'transparent'; }); });
      r.addEventListener('dblclick', () => m.close(true));
      return r;
    });
    sel.append(...rows);
    const m = modal('New LaTeX document', [el('div', { style: { width: '360px' } }, sel)], [{ label: 'Create', primary: true, value: true }, { label: 'Cancel', value: null }]);
    if (!(await m.done)) return;
    const t = DOC_TEMPLATES.find(x => x.id === chosen);
    const tp = new TexPane(this, null, t.source(eng.kind));
    await tp.mount();
    tp.compileNow();
  }

  async openFile(path) {
    const existing = this.app.panes.find(p => p.isTex && p.path === path);
    if (existing) { this.app.setActive(existing); return; }
    const text = await window.bat.readText(path);
    const tp = new TexPane(this, path, text);
    await tp.mount();
    tp.dirty = false;
    tp.updateHead();
    // show an existing PDF right away, then recompile
    const pdfPath = path.replace(/\.tex$/i, '.pdf');
    if (await window.bat.exists(pdfPath)) await tp.showPreview(pdfPath);
    if (await this.listEngines().then(l => l.length)) tp.compileNow();
  }
}

// ---------------------------------------------------------------------------
class TexPane {
  constructor(latex, path, text) {
    this.latex = latex;
    this.app = latex.app;
    this.isTex = true;
    this.id = uid();
    this.path = path;
    this.dirty = !path;
    this.autoCompile = this.app.settings.texAutoCompile !== false;
    this.build(text);
    this.compileSoon = debounce(() => this.compile(false), 1500);
  }
  get name() { return this.path ? this.path.split(/[\\/]/).pop() : 'Untitled.tex'; }

  build(text) {
    this.nameEl = el('div', { class: 'name' });
    this.status = el('span', { class: 'tex-status' });
    this.engineSel = el('select', { title: 'LaTeX engine' });
    this.latex.listEngines().then(list => {
      for (const e of list) this.engineSel.append(el('option', { value: e.id }, e.name));
      const cur = this.app.settings.texEngine && list.find(e => e.id === this.app.settings.texEngine);
      this.engineSel.value = cur ? cur.id : (list.find(e => e.kind === 'tectonic') || list[0] || {}).id || '';
    });
    this.engineSel.addEventListener('change', () => { this.app.setSettings({ texEngine: this.engineSel.value }); this.compile(true); });
    const auto = el('button', { class: this.autoCompile ? 'on' : '', title: 'Compile automatically while typing' }, 'Auto');
    auto.addEventListener('click', () => { this.autoCompile = !this.autoCompile; auto.classList.toggle('on', this.autoCompile); this.app.setSettings({ texAutoCompile: this.autoCompile }); });
    this.head = el('div', { class: 'tex-head' },
      el('span', { style: { color: 'var(--accent)' } }, '∑'), this.nameEl, this.status, this.engineSel, auto,
      el('button', { title: 'Compile (Ctrl+Enter)', onclick: () => this.compile(true) }, '▶ Compile'),
      el('button', { title: 'Save .tex (Ctrl+S)', onclick: () => this.save() }, 'Save'),
      el('button', { title: 'Close', onclick: () => this.app.closePane(this) }, '✕'));
    this.gutter = el('div', { class: 'tex-gutter' });
    this.hl = el('pre', { class: 'tex-hl', 'aria-hidden': 'true' });
    this.ta = el('textarea', { class: 'tex-src', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', wrap: 'off' });
    this.ta.value = text;
    this.logEl = el('div', { class: 'tex-log hidden' });
    this.root = el('div', { class: 'texpane' }, this.head, el('div', { class: 'tex-body' }, this.gutter, el('div', { class: 'tex-edwrap' }, this.hl, this.ta)), this.logEl);
    this.root.addEventListener('mousedown', () => this.app.setActive(this), true);
    this.ta.addEventListener('input', () => {
      this.dirty = true;
      this.updateHead();
      this.paint();
      if (this.autoCompile) this.compileSoon();
    });
    this.ta.addEventListener('scroll', () => { this.hl.scrollTop = this.ta.scrollTop; this.hl.scrollLeft = this.ta.scrollLeft; this.gutter.scrollTop = this.ta.scrollTop; });
    this.ta.addEventListener('keydown', (e) => this.onKey(e));
    this.paint();
    this.updateHead();
  }

  async mount() {
    const c = document.getElementById('panes');
    c.append(this.root);
    this.app.panes.push(this);
    this.app.layoutPanes();
    this.app.setActive(this);
    this.app.updateWelcome();
    this.app.saveSession();
    this.ta.focus();
  }

  updateHead() {
    this.nameEl.textContent = this.name + (this.dirty ? ' •' : '');
    this.nameEl.title = this.path || 'Not saved yet';
  }

  onKey(e) {
    const ta = this.ta;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'Enter') { e.preventDefault(); this.compile(true); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      const { selectionStart: a, selectionEnd: b, value: v } = ta;
      if (a !== b && v.slice(a, b).includes('\n')) {
        const ls = v.lastIndexOf('\n', a - 1) + 1;
        const block = v.slice(ls, b);
        const nb = e.shiftKey ? block.replace(/^ {1,2}/gm, '') : block.replace(/^/gm, '  ');
        ta.setRangeText(nb, ls, b, 'select');
      } else if (!e.shiftKey) insertAtCursor(ta, '  ');
      ta.dispatchEvent(new Event('input'));
      return;
    }
    if (e.key === 'Enter' && !mod) {
      // keep indentation; auto-close \begin{env}
      const { selectionStart: a, value: v } = ta;
      const ls = v.lastIndexOf('\n', a - 1) + 1;
      const line = v.slice(ls, a);
      const ind = line.match(/^\s*/)[0];
      const env = line.match(/\\begin\{([^}]+)\}\s*$/);
      e.preventDefault();
      if (env && !new RegExp('\\\\end\\{' + env[1].replace(/[*]/g, '\\*') + '\\}').test(v.slice(a, a + 400))) {
        ta.setRangeText('\n' + ind + '  \n' + ind + '\\end{' + env[1] + '}', a, ta.selectionEnd, 'start');
        ta.selectionStart = ta.selectionEnd = a + 1 + ind.length + 2;
      } else {
        ta.setRangeText('\n' + ind, a, ta.selectionEnd, 'end');
      }
      ta.dispatchEvent(new Event('input'));
      return;
    }
    const pairs = { '{': '}', '[': ']', '$': '$' };
    if (pairs[e.key] && !mod && ta.selectionStart === ta.selectionEnd) {
      const nxt = ta.value[ta.selectionStart];
      if (e.key === '$' && nxt === '$') { e.preventDefault(); ta.selectionStart = ta.selectionEnd = ta.selectionStart + 1; return; }
      if (!nxt || /\s|[)\]}]/.test(nxt)) {
        e.preventDefault();
        const a = ta.selectionStart;
        ta.setRangeText(e.key + pairs[e.key], a, a, 'start');
        ta.selectionStart = ta.selectionEnd = a + 1;
        ta.dispatchEvent(new Event('input'));
      }
    } else if ((e.key === '}' || e.key === ']') && ta.value[ta.selectionStart] === e.key && ta.selectionStart === ta.selectionEnd) {
      e.preventDefault(); ta.selectionStart = ta.selectionEnd = ta.selectionStart + 1;
    }
  }

  paint() {
    const v = this.ta.value;
    this.hl.innerHTML = highlightTex(v) + '\n';
    const n = v.split('\n').length;
    if (n !== this._lines) {
      this._lines = n;
      let s = '';
      for (let i = 1; i <= n; i++) s += i + '\n';
      this.gutter.textContent = s;
    }
  }

  gotoLine(line) {
    const lines = this.ta.value.split('\n');
    let pos = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) pos += lines[i].length + 1;
    this.ta.focus();
    this.ta.setSelectionRange(pos, pos + (lines[line - 1] || '').length);
    const lh = parseFloat(getComputedStyle(this.ta).lineHeight) || 19;
    this.ta.scrollTop = Math.max(0, (line - 5) * lh);
  }

  compileNow() { this.compile(true); }

  async compile(explicit) {
    if (this.compiling) { this.pending = true; return; }
    this.compiling = true;
    this.status.textContent = 'Compiling…';
    try {
      const eng = await this.latex.engine();
      if (!eng) { this.status.textContent = 'No LaTeX engine'; return; }
      const list = await this.latex.listEngines();
      const chosen = list.find(e => e.id === this.engineSel.value) || eng;
      let workDir, jobName;
      if (this.path) {
        workDir = window.bat.dirname(this.path);
        jobName = this.path.split(/[\\/]/).pop().replace(/\.tex$/i, '');
      } else {
        workDir = await window.bat.texScratchDir(this.id);
        jobName = 'document';
      }
      const t0 = performance.now();
      const r = await window.bat.texCompile(this.ta.value, { engine: chosen.path, kind: chosen.kind, workDir, jobName, passes: explicit ? 2 : 1 });
      if (this.path) { this.dirty = false; this.updateHead(); } // compiling writes the .tex next to the PDF
      const errs = parseLog(r.log);
      this.showLog(errs, r.ok ? '' : r.log);
      if (r.pdfPath && r.data) {
        await this.showPreview(r.pdfPath, new Uint8Array(r.data));
        this.status.textContent = (r.ok ? '✓ ' : '⚠ ') + ((performance.now() - t0) / 1000).toFixed(1) + ' s';
      } else {
        this.status.textContent = '✕ Failed';
      }
    } catch (e) {
      console.error(e);
      this.status.textContent = '✕ ' + e.message;
    } finally {
      this.compiling = false;
      if (this.pending) { this.pending = false; this.compile(false); }
    }
  }

  showLog(errs, raw) {
    const L = this.logEl;
    L.textContent = '';
    if (!errs.length && !raw) { L.classList.add('hidden'); return; }
    L.classList.remove('hidden');
    for (const e of errs) {
      const row = el('div', { class: e.level === 'error' ? 'err' : '' }, (e.line ? `line ${e.line}: ` : '') + e.msg);
      if (e.line) { row.style.cursor = 'pointer'; row.addEventListener('click', () => this.gotoLine(e.line)); }
      L.append(row);
    }
    if (!errs.length && raw) L.append(el('div', { class: 'err' }, raw.slice(-2000)));
  }

  async showPreview(pdfPath, bytes) {
    const pp = this.previewPane;
    if (pp && this.app.panes.includes(pp)) {
      if (bytes) await pp.doc.reloadBytes(bytes);
      return;
    }
    const doc = await Doc.open(pdfPath);
    if (bytes && doc.bytes !== bytes) await doc.reloadBytes(bytes);
    doc.isPreview = true;
    this.previewPane = await this.app.addPane(doc, { page: 0 }, this);
    this.app.setActive(this);
  }

  async save(as) {
    let p = this.path;
    if (!p || as) {
      p = await window.bat.saveTexDialog(this.path || 'document.tex');
      if (!p) return false;
      if (!/\.tex$/i.test(p)) p += '.tex';
    }
    await window.bat.writeText(p, this.ta.value);
    const first = !this.path;
    this.path = p;
    this.dirty = false;
    this.updateHead();
    this.app.saveSession();
    toast('Saved ' + this.name);
    if (first || as) { if (this.previewPane) { this.app.closePane(this.previewPane); this.previewPane = null; } this.compile(true); }
    return true;
  }

  async confirmClose() {
    if (!this.dirty) return true;
    const r = await window.bat.confirm(`Save changes to “${this.name}”?`, '', ['Save', 'Don’t save', 'Cancel']);
    if (r === 2) return false;
    if (r === 0) return await this.save();
    return true;
  }

  destroy() { this.root.remove(); }
}

// ---------------------------------------------------------------------------
function insertAtCursor(ta, text) {
  const a = ta.selectionStart;
  ta.setRangeText(text, a, ta.selectionEnd, 'end');
}

function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

export function highlightTex(src) {
  let out = '';
  let i = 0, inMath = false;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '%' ) {
      const j = src.indexOf('\n', i);
      const e = j < 0 ? n : j;
      out += '<span class="tc">' + esc(src.slice(i, e)) + '</span>';
      i = e;
      continue;
    }
    if (c === '\\') {
      const m = /^\\([a-zA-Z@]+\*?|.)/.exec(src.slice(i, i + 64));
      const tok = m ? m[0] : '\\';
      const cls = /^\\(begin|end|section|subsection|subsubsection|chapter|part|paragraph|documentclass|usepackage|title|author|maketitle)\b/.test(tok) ? 'tk' : (/^\\[[\]()]$/.test(tok) ? 'tm' : 'tx');
      if (tok === '\\[' || tok === '\\(') inMath = true;
      if (tok === '\\]' || tok === '\\)') inMath = false;
      out += `<span class="${cls}">` + esc(tok) + '</span>';
      i += tok.length;
      continue;
    }
    if (c === '$') {
      const dbl = src[i + 1] === '$';
      inMath = !inMath;
      out += '<span class="tm">' + (dbl ? '$$' : '$') + '</span>';
      i += dbl ? 2 : 1;
      continue;
    }
    if (c === '{' || c === '}' || c === '[' || c === ']') { out += '<span class="tb">' + c + '</span>'; i++; continue; }
    // plain run
    let j = i;
    while (j < n && !'%\\$[]{}'.includes(src[j])) j++;
    const txt = esc(src.slice(i, j));
    out += inMath ? '<span class="tmi">' + txt + '</span>' : txt;
    i = j;
  }
  return out;
}

export function parseLog(log) {
  const out = [];
  if (!log) return out;
  const seen = new Set();
  const add = (level, line, msg) => {
    const k = level + line + msg;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ level, line, msg: msg.trim() });
  };
  const lines = log.split(/\r?\n/);
  for (let k = 0; k < lines.length; k++) {
    const l = lines[k];
    let m;
    if ((m = /^(error|warning):\s*(?:[^:]*\.tex):(\d+):\s*(.*)$/.exec(l))) add(m[1], +m[2], m[3]);
    else if ((m = /^(?:\.\/|[A-Za-z]:\\|\/)?[^:\s][^:]*\.tex:(\d+):\s*(.*)$/.exec(l))) add('error', +m[1], m[2]);
    else if ((m = /^!\s*(.*)$/.exec(l))) {
      let line = null;
      for (let q = k + 1; q < Math.min(lines.length, k + 12); q++) { const mm = /^l\.(\d+)/.exec(lines[q]); if (mm) { line = +mm[1]; break; } }
      add('error', line, m[1]);
    } else if ((m = /^error:\s*(.*)$/.exec(l))) add('error', null, m[1]);
    else if ((m = /^(LaTeX|Package \w+) Warning: (.*)$/.exec(l))) {
      const lm = /on input line (\d+)/.exec(l + (lines[k + 1] || ''));
      add('warning', lm ? +lm[1] : null, m[2]);
    }
  }
  return out.slice(0, 50);
}

function extractErrors(log) {
  const e = parseLog(log).filter(x => x.level === 'error');
  return e.map(x => (x.line ? `line ${x.line}: ` : '') + x.msg).join('\n');
}

async function renderFirstPage(bytes, scale) {
  const pdf = await loadPdfjs(bytes);
  try {
    const page = await pdf.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp, background: 'rgba(0,0,0,0)' }).promise;
    return { url: c.toDataURL('image/png'), w: vp1.width, h: vp1.height };
  } finally { pdf.destroy(); }
}
