// Small shared helpers.
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}

export const svgNS = 'http://www.w3.org/2000/svg';
export function sv(tag, attrs = {}) {
  const e = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  return e;
}

export class Emitter {
  constructor() { this._h = {}; }
  on(ev, fn) { (this._h[ev] ||= new Set()).add(fn); return () => this._h[ev].delete(fn); }
  emit(ev, ...a) { for (const fn of this._h[ev] || []) fn(...a); }
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
export function rgbToHex(rgb) {
  if (!rgb || rgb.length < 3) return '#ffd400';
  return '#' + rgb.slice(0, 3).map(v => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')).join('');
}

let toastTimer;
export function toast(msg, ms = 2200) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// Minimal modal dialog. Returns {root, body, close, done:Promise}.
export function modal(title, bodyNodes, buttons = [{ label: 'OK', value: true, primary: true }, { label: 'Cancel', value: null }]) {
  let resolve;
  const done = new Promise(r => { resolve = r; });
  const body = el('div', { class: 'body' }, bodyNodes);
  const foot = el('div', { class: 'foot' });
  const dlg = el('div', { class: 'modal' }, el('h3', {}, title), body, foot);
  const back = el('div', { class: 'modal-back' }, dlg);
  const close = (v) => { back.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
  for (const b of buttons) {
    if (b.spacer) { foot.append(el('div', { class: 'spacer' }, b.node || '')); continue; }
    foot.append(el('button', { class: b.primary ? 'primary' : '', onclick: async () => {
      if (b.action) { const r = await b.action(); if (r === false) return; close(r === undefined ? b.value : r); }
      else close(b.value);
    } }, b.label));
  }
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(null); }
  };
  document.addEventListener('keydown', onKey, true);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(null); });
  document.getElementById('modalRoot').append(back);
  return { root: dlg, body, foot, close, done };
}

export function prompt(title, value = '', label = '') {
  const inp = el('input', { value, style: { width: '100%' } });
  const m = modal(title, [label ? el('label', {}, label) : null, inp], [
    { label: 'OK', primary: true, action: () => inp.value },
    { label: 'Cancel', value: null }
  ]);
  setTimeout(() => { inp.focus(); inp.select(); }, 0);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') m.close(inp.value); });
  return m.done;
}

export const fmtDate = (ts) => new Date(ts).toLocaleString();
export const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));
