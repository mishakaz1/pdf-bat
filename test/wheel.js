// Touchpad scrolling: a mostly-vertical swipe (< 30° from vertical) scrolls only vertically;
// a clearly sideways swipe scrolls sideways too.
const { _electron: electron } = require('playwright');
const path = require('path'), fs = require('fs'), os = require('os');
const root = path.join(__dirname, '..');
(async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-'));
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'book-plain.pdf'), path.join(work, 'b.pdf'));
  const app = await electron.launch({ executablePath: require(path.join(root, 'node_modules', 'electron')), args: ['--no-sandbox', root, path.join(work, 'b.pdf')], env: Object.assign({}, process.env, { PDFBAT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ud-')) }) });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', e => errors.push(e.message));
  await win.setViewportSize({ width: 1200, height: 800 });
  await win.waitForSelector('.page[data-page="0"] canvas', { timeout: 20000 });
  const check = (c, m) => { if (!c) throw new Error('FAILED: ' + m); console.log('ok -', m); };
  await win.evaluate(() => app.active.zoomBy(3));
  await win.waitForTimeout(700);
  const pos = () => win.evaluate(() => { const s = app.active.scrollEl; return { x: s.scrollLeft, y: s.scrollTop, maxX: s.scrollWidth - s.clientWidth }; });
  const box = await win.locator('.pane-scroll').boundingBox();
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  let a = await pos();
  check(a.maxX > 200, 'page is wider than the pane (can scroll sideways)');
  // 18° from vertical, in small steps like a touchpad
  for (let i = 0; i < 8; i++) { await win.mouse.wheel(4, 12); await win.waitForTimeout(16); }
  await win.waitForTimeout(150);
  let b = await pos();
  check(b.y > a.y + 60 && Math.abs(b.x - a.x) < 1, `slanted swipe (18°) scrolls only down: dy=${b.y - a.y} dx=${b.x - a.x}`);
  await win.waitForTimeout(400); // new gesture
  a = b;
  for (let i = 0; i < 8; i++) { await win.mouse.wheel(12, 4); await win.waitForTimeout(16); }
  await win.waitForTimeout(150);
  b = await pos();
  check(Math.abs(b.x - a.x) > 40, `sideways swipe (72°) scrolls sideways: dx=${b.x - a.x}`);
  await win.waitForTimeout(400);
  a = b;
  for (let i = 0; i < 6; i++) { await win.mouse.wheel(0, 20); await win.waitForTimeout(16); }
  await win.waitForTimeout(150);
  b = await pos();
  check(b.y > a.y + 60 && b.x === a.x, 'plain vertical scroll unchanged');
  check(errors.length === 0, 'no renderer errors ' + errors.join('; '));
  await app.close();
  console.log('   (electron exited)');
})().catch(e => { console.error(e); process.exit(1); });
