// Link hover preview, smart jump (Alt+click on "Figure 2", "Eq. (2.14)", "Theorem 3.1"), quick open, notes search.
const { _electron: electron } = require('playwright');
const path = require('path'), fs = require('fs'), os = require('os');
const root = path.join(__dirname, '..');
(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-'));
  for (const f of ['refs.pdf', 'book-bookmarks.pdf']) fs.copyFileSync(path.join(__dirname, 'fixtures', f), path.join(work, f));
  const app = await electron.launch({ executablePath: require(path.join(root, 'node_modules', 'electron')), args: ['--no-sandbox', root, path.join(work, 'refs.pdf')], env: Object.assign({}, process.env, { PDFBAT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ud-')) }) });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', e => errors.push(e.message));
  await win.setViewportSize({ width: 1400, height: 900 });
  await win.waitForSelector('.page[data-page="0"] .textLayer span', { timeout: 20000 });
  const check = (c, m) => { if (!c) throw new Error('FAILED: ' + m); console.log('ok -', m); };
  const span = win.locator('.page[data-page="0"] .textLayer span', { hasText: 'Figure 2' }).first();
  const bb = await span.boundingBox();
  const clickWord = async (word) => {
    const x = await span.evaluate((s, w) => {
      const t = s.textContent, i = t.indexOf(w), r = document.createRange(), n = s.firstChild;
      r.setStart(n, i + 1); r.setEnd(n, i + 2); const b = r.getBoundingClientRect(); return b.left + b.width / 2;
    }, word);
    await win.keyboard.down('Alt'); await win.mouse.click(x, bb.y + bb.height / 2); await win.keyboard.up('Alt');
    await win.waitForSelector('.pv-pop .pv-canvas', { timeout: 10000 });
    await win.waitForTimeout(300);
    return win.locator('.pv-pop .pv-label').textContent();
  };
  let l = await clickWord('Figure 2'); check(/Figure 2 — p\. 5/.test(l), 'smart jump Figure 2 → ' + l);
  await win.screenshot({ path: path.join(__dirname, 'shots', '20-smart-jump.png') });
  await win.keyboard.press('Escape');
  l = await clickWord('(2.14)'); check(/p\. 3/.test(l), 'smart jump equation → ' + l);
  await win.keyboard.press('Escape');
  l = await clickWord('Theorem 3.1'); check(/Theorem 3\.1 — p\. 3/.test(l), 'smart jump theorem → ' + l);
  await win.click('.pv-pop');
  await win.waitForTimeout(400);
  check(await win.evaluate(() => app.active.current === 2), 'clicking the preview jumps there');
  await win.keyboard.press('Alt+ArrowLeft');
  await win.waitForTimeout(300);
  check(await win.evaluate(() => app.active.current === 0), 'Alt+← comes back');
  // link hover preview
  await win.evaluate((p) => app.openPaths([p]), path.join(work, 'book-bookmarks.pdf'));
  await win.waitForSelector('.pane:nth-child(3) .page[data-page="0"] .links a', { timeout: 20000 }).catch(() => {});
  const link = win.locator('.links a').first();
  await link.hover();
  await win.waitForSelector('.pv-pop .pv-canvas', { timeout: 5000 });
  l = await win.locator('.pv-pop .pv-label').textContent();
  check(/p\. 13/.test(l), 'hovering an internal link previews its target → ' + l);
  await win.mouse.move(5, 500);
  // quick open
  await win.keyboard.press('Control+p');
  await win.waitForSelector('.modal input');
  await win.keyboard.type('refs');
  const first = await win.locator('.modal .list .entry').first().textContent();
  check(/refs\.pdf/.test(first), 'Ctrl+P quick open filters recent files');
  await win.keyboard.press('Escape');
  check(errors.length === 0, 'no renderer errors ' + errors.join('\n'));
  await app.close();
})().catch(e => { console.error(e); process.exit(1); });
