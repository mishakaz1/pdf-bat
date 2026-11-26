// Previews of other places in the document without leaving the current one:
//  * hovering an internal link shows where it points
//  * Alt+click (or middle-click) on "Figure 3", "Eq. (2.14)", "(2.14)", "Theorem 4.1", "Table 2", "Section 3.2"
//    finds that place even when the PDF has no links ("smart jump")
import { el } from './util.js';
import { pageText } from './doc.js';

let popup = null, hideTimer = null;
document.addEventListener('mousedown', (e) => { if (popup && !popup.contains(e.target)) hidePreview(); }, true);

export function hidePreview() {
  clearTimeout(hideTimer);
  if (popup) { popup.remove(); popup = null; }
}
function scheduleHide(ms = 250) { clearTimeout(hideTimer); hideTimer = setTimeout(hidePreview, ms); }

// Show a rendered crop of page `page` around pdf y-coordinate `y` near the screen point (cx, cy).
export async function showPreview(pane, target, cx, cy, opts = {}) {
  hidePreview();
  const W = Math.min(520, window.innerWidth - 40), H = 280;
  const canvas = el('canvas');
  const label = el('div', { class: 'pv-label' }, opts.label ? `${opts.label} — p. ${target.page + 1}` : `p. ${target.page + 1}`);
  const box = el('div', { class: 'pv-pop' }, el('div', { class: 'pv-canvas' }, canvas), label);
  popup = box;
  document.body.append(box);
  // position: below the cursor, or above if there is no room
  const left = Math.max(10, Math.min(cx - W / 2, window.innerWidth - W - 10));
  const top = cy + 18 + H + 40 < window.innerHeight ? cy + 18 : Math.max(10, cy - H - 60);
  Object.assign(box.style, { left: left + 'px', top: top + 'px', width: W + 'px' });
  box.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  box.addEventListener('mouseleave', () => { if (!opts.sticky) scheduleHide(); });
  box.addEventListener('click', () => { hidePreview(); pane.goto(target.page, { push: true, pdfY: target.y != null ? target.y + 20 : null }); });
  box.title = 'Click to go there (Alt+← to come back)';
  try {
    const page = pane.doc.proxies[target.page];
    const base = page.getViewport({ scale: 1 });
    const scale = (W / base.width) * 1.0;
    const dpr = window.devicePixelRatio || 1;
    const vp = page.getViewport({ scale: scale * dpr });
    // top of the crop: a bit above the target line
    let yTop = 0;
    if (target.y != null) {
      const [, vy] = vp.convertToViewportPoint(target.x || 0, target.y);
      // figures: the caption is under the figure, so put the caption near the bottom of the preview
      const pad = opts.anchor === 'bottom' ? (H - 40) : 40;
      yTop = Math.max(0, Math.min(vp.height - H * dpr, vy - pad * dpr));
    }
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, 0, -yTop] }).promise;
  } catch (e) { label.textContent += ' (preview failed)'; }
}

export function bindLinkPreview(pane, link, getTarget) {
  let t = null;
  link.addEventListener('mouseenter', (e) => {
    clearTimeout(t);
    const { clientX, clientY } = e;
    t = setTimeout(async () => {
      const target = await getTarget();
      if (target && link.matches(':hover')) showPreview(pane, target, clientX, clientY);
    }, 350);
  });
  link.addEventListener('mouseleave', () => { clearTimeout(t); scheduleHide(); });
  link.addEventListener('mousedown', () => { clearTimeout(t); hidePreview(); });
}

// ---------- smart jump ----------
const NUM = '(\\d+(?:[.\\-–]\\d+)*[a-z]?)';
const KINDS = [
  { kind: 'figure', re: new RegExp(`\\b(?:Figure|Fig\\.?|Рис(?:унок)?\\.?)\\s*${NUM}`, 'i'), caption: (n) => new RegExp(`^\\s*(?:Figure|Fig\\.?|Рис(?:унок)?\\.?)\\s*${esc(n)}(?![\\d.]\\d)`, 'i') },
  { kind: 'table', re: new RegExp(`\\b(?:Table|Tab\\.?|Таблиця|Табл\\.?)\\s*${NUM}`, 'i'), caption: (n) => new RegExp(`^\\s*(?:Table|Tab\\.?|Таблиця|Табл\\.?)\\s*${esc(n)}(?![\\d.]\\d)`, 'i') },
  { kind: 'theorem', re: new RegExp(`\\b(Theorem|Lemma|Corollary|Proposition|Definition|Example|Exercise|Problem|Remark|Теорема|Лема|Означення|Приклад|Задача|Вправа)\\s*${NUM}`, 'i'), caption: (n, w) => new RegExp(`^\\s*${w}\\s*${esc(n)}(?![\\d.]\\d)`, 'i') },
  { kind: 'section', re: new RegExp(`(?:\\b(?:Section|Sec\\.?|Chapter|Розділ|Глава|Параграф)\\s*|§\\s*)${NUM}`, 'i'), caption: (n) => new RegExp(`^\\s*(?:§\\s*|Chapter\\s*|Розділ\\s*)?${esc(n)}\\.?\\s+\\S`, 'i') },
  { kind: 'equation', re: new RegExp(`(?:\\b(?:Eqs?\\.?|Equations?|рівн(?:яння)?\\.?|ф-ла|формул[аиі])\\s*)?\\(${NUM}\\)`, 'i'), tag: true }
];
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\\-–]/g, '\\$&'); }

// Which reference is at the clicked point?
export function referenceAt(text, offset) {
  const found = [];
  for (const k of KINDS) {
    const g = new RegExp(k.re.source, 'gi');
    let m;
    while ((m = g.exec(text))) {
      found.push({ k, m, start: m.index, end: m.index + m[0].length });
      if (m[0].length === 0) g.lastIndex++;
    }
  }
  if (!found.length) return null;
  found.sort((a, b) => Math.abs((a.start + a.end) / 2 - offset) - Math.abs((b.start + b.end) / 2 - offset));
  const hit = found.find(f => offset >= f.start - 1 && offset <= f.end + 1) || found[0];
  const { k, m } = hit;
  const num = m[m.length - 1];
  const word = k.kind === 'theorem' ? m[1] : null;
  return { kind: k.kind, num, word, label: m[0].trim(), def: k };
}

// Find where the referenced object is defined. Returns {page, y, x} or null.
export async function findReference(doc, ref, fromPage) {
  const n = doc.numPages;
  const order = [];
  // captions/tags are usually close to where they are referenced: search outward from the current page
  for (let d = 0; d < n; d++) {
    if (fromPage + d < n) order.push(fromPage + d);
    if (d && fromPage - d >= 0) order.push(fromPage - d);
  }
  let best = null;
  for (const i of order) {
    const tc = await pageText(doc, i);
    const lines = linesOf(tc);
    const w = doc.sizes[i].w;
    for (const ln of lines) {
      if (ref.kind === 'equation') {
        const t = ln.text.trim();
        // an equation tag sits at the end of a line, usually right-aligned: "... (2.14)"
        if (new RegExp(`\\(${esc(ref.num)}\\)\\s*$`).test(t) && ln.xEnd > w * 0.55 && !/(?:Eq|рівн)/i.test(t.slice(-20))) {
          return { page: i, y: ln.y + ln.size, x: 0 };
        }
      } else {
        const re = ref.def.caption(ref.num, ref.word && esc(ref.word));
        if (re.test(ln.text)) {
          // prefer captions/headings that are not just running text: short-ish line start, or bold/larger
          const score = (ln.text.length < 140 ? 2 : 0) + (i === fromPage ? 0 : 1);
          if (!best || score > best.score) best = { page: i, y: ln.y + ln.size, x: 0, score };
          if (score >= 3) return best;
        }
      }
    }
    if (best && Math.abs(i - fromPage) > 30) break;
  }
  return best;
}

function linesOf(tc) {
  const out = [];
  let cur = null;
  for (const it of tc.items) {
    if (it.str === undefined) continue;
    const tr = it.transform;
    const size = Math.hypot(tr[2], tr[3]) || 10;
    const y = tr[5];
    if (cur && Math.abs(cur.y - y) < size * 0.5) {
      cur.text += (it.str && cur.text && !cur.text.endsWith(' ') && !it.str.startsWith(' ') && tr[4] - cur.xEnd > size * 0.2 ? ' ' : '') + it.str;
      cur.xEnd = Math.max(cur.xEnd, tr[4] + (it.width || 0));
    } else {
      if (cur) out.push(cur);
      cur = { text: it.str, y, size, x: tr[4], xEnd: tr[4] + (it.width || 0) };
    }
    if (it.hasEOL) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}

// Alt+click / middle-click handler for a pane
export async function smartJump(pane, e) {
  const pos = document.caretRangeFromPoint ? document.caretRangeFromPoint(e.clientX, e.clientY) : null;
  const span = e.target.closest && e.target.closest('.textLayer span');
  if (!span) return false;
  let text = span.textContent, offset = text.length / 2;
  if (pos && span.contains(pos.startContainer)) {
    // offset within the span's full text
    let o = 0;
    const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) { if (node === pos.startContainer) { o += pos.startOffset; break; } o += node.textContent.length; }
    offset = o;
  }
  // include neighbouring spans so "Figure" and "3" split across spans still match
  const prev = span.previousElementSibling, next = span.nextElementSibling;
  const before = prev && prev.tagName === 'SPAN' ? prev.textContent + ' ' : '';
  const after = next && next.tagName === 'SPAN' ? ' ' + next.textContent : '';
  const ref = referenceAt(before + text + after, before.length + offset);
  if (!ref) return false;
  const pageEl = span.closest('.page');
  const from = +pageEl.dataset.page;
  showSearching(e.clientX, e.clientY, ref.label);
  const target = await findReference(pane.doc, ref, from);
  if (!target) { showSearching(e.clientX, e.clientY, `${ref.label}: not found`, 1500); return true; }
  showPreview(pane, target, e.clientX, e.clientY, { label: ref.label, sticky: true, anchor: ref.kind === 'figure' ? 'bottom' : 'top' });
  return true;
}

function showSearching(x, y, text, autoHide) {
  hidePreview();
  popup = el('div', { class: 'pv-pop small', style: { left: (x + 10) + 'px', top: (y + 16) + 'px' } }, el('div', { class: 'pv-label' }, text + (autoHide ? '' : ' …')));
  document.body.append(popup);
  if (autoHide) scheduleHide(autoHide);
}
