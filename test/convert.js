// Opening DjVu / EPUB / FB2 / CBZ / images converts them to PDF next to the original and opens that PDF.
const { _electron: electron } = require('playwright');
const path = require('path'), fs = require('fs'), os = require('os');
const root = path.join(__dirname, '..');
const SHOTS = path.join(__dirname, 'shots');
(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-'));
  for (const f of ['spec.djvu', 'color.djvu', 'book.epub', 'book.fb2', 'comic.cbz', 'photo.jpg', 'scan.png']) fs.copyFileSync(path.join(__dirname, 'fixtures', f), path.join(work, f));
  const W = (f) => path.join(work, f);
  const app = await electron.launch({ executablePath: require(path.join(root, 'node_modules', 'electron')), args: ['--no-sandbox', root], env: Object.assign({}, process.env, { PDFBAT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ud-')) }) });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', e => errors.push(e.message));
  win.on('console', m => { if (m.type() === 'warning' && /DjVu page/.test(m.text())) console.log('   warn:', m.text()); });
  await win.setViewportSize({ width: 1400, height: 900 });
  await win.waitForFunction(() => window.app);
  const check = (c, m) => { if (!c) throw new Error('FAILED: ' + m); console.log('ok -', m); };
  const open = (ps) => win.evaluate(async (ps) => { await app.openPaths(ps); const d = app.active.doc; return { path: d.path, n: d.numPages }; }, ps);
  const outline = () => win.evaluate(async () => {
    const o = await app.active.doc.pdf.getOutline();
    const walk = (l) => (l || []).map(x => ({ t: x.title, c: walk(x.items) }));
    return walk(o);
  });
  const text = (from, to) => win.evaluate(async ([a, b]) => {
    const pdf = app.active.doc.pdf; let s = '';
    for (let i = a; i <= Math.min(b, pdf.numPages); i++) s += (await (await pdf.getPage(i)).getTextContent()).items.map(x => x.str).join(' ') + '\n';
    return s;
  }, [from, to]);
  // fraction of non-white pixels in a rendered page: proves the page is not blank
  const ink = (page) => win.evaluate(async (p) => {
    const pg = await app.active.doc.pdf.getPage(p);
    const vp = pg.getViewport({ scale: 0.5 });
    const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
    const ctx = c.getContext('2d');
    await pg.render({ canvasContext: ctx, viewport: vp }).promise;
    const d = ctx.getImageData(0, 0, c.width, c.height).data; let k = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 600) k++;
    return k / (d.length / 4);
  }, page);

  // --- DjVu (bitonal book with contents) ---
  let t0 = Date.now();
  let r = await open([W('spec.djvu')]);
  const djvuSecs = (Date.now() - t0) / 1000;
  check(r.path === W('spec.pdf') && fs.existsSync(W('spec.pdf')), 'DjVu converted to a PDF next to the original');
  check(r.n > 50, `DjVu: all pages (${r.n}) in ${djvuSecs.toFixed(1)} s`);
  const p1ink = await ink(1);
  check(p1ink > 0.005 && p1ink < 0.5, `DjVu page 1 has content (${(p1ink * 100).toFixed(1)}% ink)`);
  // every page must show something (catches broken text masks on colour pages)
  const blank = await win.evaluate(async () => {
    const pdf = app.active.doc.pdf, out = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      const pg = await pdf.getPage(p); const vp = pg.getViewport({ scale: 0.25 });
      const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
      const ctx = c.getContext('2d'); await pg.render({ canvasContext: ctx, viewport: vp }).promise;
      const d = ctx.getImageData(0, 0, c.width, c.height).data; let k = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < 600) k++;
      if (k / (d.length / 4) < 0.003) out.push(p);
    }
    return out;
  });
  check(blank.length === 0, 'DjVu: no blank pages ' + blank.join(','));
  let ol = await outline();
  const count = (l) => l.reduce((a, x) => a + 1 + count(x.c), 0);
  check(count(ol) > 10 && ol[0].c.some(x => x.t === 'Introduction'), `DjVu contents became PDF bookmarks (${count(ol)})`);
  const sizeKB = fs.statSync(W('spec.pdf')).size / 1024;
  check(sizeKB < 100 * r.n, `DjVu PDF size reasonable (${Math.round(sizeKB)} KB for ${r.n} pages)`);
  await win.waitForSelector('.page[data-page="0"] canvas', { timeout: 20000 });
  await win.waitForTimeout(800);
  await win.screenshot({ path: path.join(SHOTS, '30-djvu.png') });

  // re-opening the same DjVu uses the converted PDF (no second conversion)
  await win.evaluate(() => app.closePane ? app.closePane(app.active) : null);
  const mt = fs.statSync(W('spec.pdf')).mtimeMs;
  t0 = Date.now();
  r = await open([W('spec.djvu')]);
  check(r.path === W('spec.pdf') && fs.statSync(W('spec.pdf')).mtimeMs === mt && Date.now() - t0 < 5000, 'second open reuses the converted PDF');

  // --- colour DjVu ---
  r = await open([W('color.djvu')]);
  const cink = await ink(1);
  check(r.n === 2 && cink > 0.05, 'colour DjVu page rendered (' + (cink * 100).toFixed(1) + '% ink)');

  // --- EPUB ---
  r = await open([W('book.epub')]);
  check(r.path === W('book.pdf') && r.n >= 3, `EPUB laid out into ${r.n} pages`);
  const et = await text(1, r.n);
  check(et.includes('Закон збереження') && /αβγ/.test(et), 'EPUB: Ukrainian and Greek text kept');
  check(!et.includes('HACKED'), 'EPUB: scripts inside the book do not run');
  ol = await outline();
  check(ol.length === 2 && ol[0].t === 'Розділ 1. Механіка' && ol[0].c.length === 1, 'EPUB: table of contents → bookmarks');
  await win.waitForTimeout(800);
  await win.screenshot({ path: path.join(SHOTS, '31-epub.png') });

  // --- FB2 (windows-1251) ---
  r = await open([W('book.fb2')]);
  const ft = await text(1, r.n);
  check(ft.includes('Реве та стогне') && ft.includes('Шевченко'), 'FB2: windows-1251 text decoded');
  ol = await outline();
  check(ol.map(x => x.t).join('|') === 'Перший розділ|Другий розділ', 'FB2: chapters → bookmarks');
  check((await ink(1)) > 0.2, 'FB2: cover image on page 1');

  // --- CBZ ---
  r = await open([W('comic.cbz')]);
  check(r.n === 3, 'CBZ: 3 pages');

  // --- several images → one PDF ---
  r = await open([W('photo.jpg'), W('scan.png')]);
  check(r.n === 2 && /\(2 images\)\.pdf$/.test(r.path), 'two images combined into one PDF');

  // --- broken file → message, no crash ---
  fs.writeFileSync(W('broken.epub'), 'not a zip');
  const before = await win.evaluate(() => app.panes.length);
  await win.evaluate((p) => app.openPaths([p]), W('broken.epub'));
  const toastTxt = await win.evaluate(() => document.body.innerText);
  check((await win.evaluate(() => app.panes.length)) === before && /Could not convert broken\.epub/.test(toastTxt), 'broken file: clear message, nothing opened');

  check(errors.length === 0, 'no renderer errors ' + errors.join('; '));
  await app.close();
  console.log('   (electron exited)');
})().catch(e => { console.error(e); process.exit(1); });
