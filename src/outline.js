// Table of contents: PDF bookmarks if present, otherwise detected from typography.
import { pageText } from './doc.js';
import { resolveDest } from './pane.js';

const cache = new WeakMap();

export function getOutline(doc, onProgress) {
  let c = cache.get(doc.pdf);
  if (!c) { c = build(doc, onProgress); cache.set(doc.pdf, c); }
  return c;
}

async function build(doc, onProgress) {
  let raw = null;
  try { raw = await doc.pdf.getOutline(); } catch (_) {}
  if (raw && raw.length) {
    const items = await convert(doc.pdf, raw, 0);
    if (countItems(items) > 0) return { source: 'bookmarks', items };
  }
  const items = await detectHeadings(doc, onProgress);
  return { source: 'detected', items };
}

function countItems(items) { return items.reduce((n, it) => n + 1 + countItems(it.children), 0); }

async function convert(pdf, nodes, depth) {
  const out = [];
  for (const n of nodes) {
    let page = null, y = null;
    try {
      if (n.dest) { const r = await resolveDest(pdf, n.dest); if (r) { page = r.page; y = r.y; } }
    } catch (_) {}
    out.push({ title: (n.title || '').trim() || '(untitled)', page, y, url: n.url || null, depth, children: n.items && n.items.length ? await convert(pdf, n.items, depth + 1) : [] });
  }
  return out;
}

// ---- heuristic detection ----
const KEYWORD = /^(chapter|part|section|appendix|lecture|lesson|розділ|частина|глава|додаток|лекція|тема|параграф|§)\s*[\dIVXLCDMivxlcdmА-ЯA-Z]*/i;
const NUMBERED = /^(\d{1,2}(\.\d{1,2}){0,3}\.?|[IVXLC]{1,6}\.|[A-Z]\.)\s+\S/;

async function detectHeadings(doc, onProgress) {
  const n = doc.numPages;
  const limit = Math.min(n, 1500);
  const lines = []; // {page, text, size, y, bold}
  const sizeHist = new Map();
  for (let i = 0; i < limit; i++) {
    const tc = await pageText(doc, i);
    const pageLines = groupLines(tc, i);
    for (const l of pageLines) {
      const k = Math.round(l.size * 2) / 2;
      sizeHist.set(k, (sizeHist.get(k) || 0) + l.text.length);
      lines.push(l);
    }
    if (onProgress && i % 40 === 0) onProgress(i / limit);
  }
  if (!lines.length) return [];
  // body size = most common size weighted by characters
  let body = 10, best = -1;
  for (const [s, c] of sizeHist) if (c > best) { best = c; body = s; }
  // repeated running headers/footers: same text on many pages
  const freq = new Map(), posFreq = new Map();
  for (const l of lines) {
    const k = l.text.trim().toLowerCase();
    freq.set(k, (freq.get(k) || 0) + 1);
    const pk = normalize(l.text) + '@' + Math.round(l.y / 4);
    posFreq.set(pk, (posFreq.get(pk) || 0) + 1);
  }
  const isRepeated = (l) => freq.get(l.text.trim().toLowerCase()) > Math.max(3, limit * 0.05) || (l.size < body * 1.2 && posFreq.get(normalize(l.text) + '@' + Math.round(l.y / 4)) > Math.max(4, limit * 0.25));
  const cands = [];
  for (const l of lines) {
    const t = l.text.trim();
    if (t.length < 2 || t.length > 90) continue;
    if (/^[\d\s.,\-–—]+$/.test(t)) continue;           // page numbers, etc.
    if (isRepeated(l)) continue;
    const ratio = l.size / body;
    const kw = KEYWORD.test(t);
    const num = NUMBERED.test(t);
    let score = 0;
    if (ratio >= 1.6) score = 3;
    else if (ratio >= 1.3) score = 2;
    else if (ratio >= 1.12) score = 1;
    if (l.bold && ratio >= 1.0 && (num || kw)) score = Math.max(score, 1);
    if (kw && ratio >= 1.05) score += 1;
    if (!score) continue;
    if (/[.:;,]$/.test(t) && !kw && t.length > 40) continue; // sentence-like
    cands.push(Object.assign({ score }, l));
  }
  // merge consecutive candidate lines on same page with same size (multi-line titles)
  const merged = [];
  for (const c of cands) {
    const p = merged[merged.length - 1];
    if (p && p.page === c.page && Math.abs(p.size - c.size) < 0.3 && Math.abs(p.yEnd - c.y) < c.size * 1.8 && (p.text + ' ' + c.text).length < 110) {
      p.text += ' ' + c.text; p.yEnd = c.y; continue;
    }
    merged.push(Object.assign({ yEnd: c.y }, c));
  }
  if (!merged.length) return [];
  // levels by distinct font size (largest = level 0), at most 3 levels
  const sizes = Array.from(new Set(merged.map(m => Math.round(m.size * 2) / 2))).sort((a, b) => b - a);
  const lvl = new Map(sizes.map((s, i) => [s, Math.min(i, 2)]));
  // too many candidates → keep only the larger levels
  let chosen = merged;
  if (chosen.length > 600) chosen = chosen.filter(m => lvl.get(Math.round(m.size * 2) / 2) <= 1);
  if (chosen.length > 600) chosen = chosen.filter(m => lvl.get(Math.round(m.size * 2) / 2) === 0);
  // build tree
  const root = [];
  const stack = [];
  for (const m of chosen) {
    const depth = lvl.get(Math.round(m.size * 2) / 2);
    const item = { title: m.text.replace(/\s+/g, ' ').trim(), page: m.page, y: m.yTop, depth, children: [] };
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(item); else root.push(item);
    stack.push(item);
  }
  return root;
}

function normalize(t) { return t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim(); }

function groupLines(tc, page) {
  const out = [];
  let cur = null;
  for (const it of tc.items) {
    if (!it.str && !it.hasEOL) continue;
    const tr = it.transform;
    const size = Math.hypot(tr[2], tr[3]) || Math.abs(tr[3]) || it.height || 0;
    const y = tr[5];
    const style = tc.styles[it.fontName] || {};
    const bold = /bold|black|heavy|semibold|-bd|\.b$/i.test(it.fontName + ' ' + (style.fontFamily || ''));
    if (cur && Math.abs(cur.y - y) < Math.max(1.5, size * 0.4) && Math.abs(cur.size - size) < Math.max(1, size * 0.25)) {
      cur.text += (cur.text && !cur.text.endsWith(' ') && it.str && !it.str.startsWith(' ') && (tr[4] - cur.xEnd) > size * 0.15 ? ' ' : '') + it.str;
      cur.xEnd = tr[4] + (it.width || 0);
      cur.bold = cur.bold && bold;
    } else {
      if (cur && cur.text.trim()) out.push(cur);
      cur = { page, text: it.str, size, y, yTop: y + size, xEnd: tr[4] + (it.width || 0), bold };
    }
    if (it.hasEOL) { if (cur && cur.text.trim()) out.push(cur); cur = null; }
  }
  if (cur && cur.text.trim()) out.push(cur);
  return out;
}

// Flatten for "current section" lookup
export function flatten(items, out = []) {
  for (const it of items) { out.push(it); flatten(it.children, out); }
  return out;
}
