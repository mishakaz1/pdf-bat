// Pages stay horizontally centred (zoom, split, resize) until the user scrolls sideways.
const { _electron: electron } = require('playwright');
const path = require('path'), fs = require('fs'), os = require('os');
const root = path.join(__dirname, '..');
(async () => {
  const app = await electron.launch({ executablePath: require(path.join(root, 'node_modules', 'electron')), args: ['--no-sandbox', root, path.join(__dirname, 'fixtures', 'book-plain.pdf')], env: Object.assign({}, process.env, { PDFBAT_USERDATA: fs.mkdtempSync(path.join(os.tmpdir(), 'ud-')) }) });
  const win = await app.firstWindow();
  await win.setViewportSize({ width: 1400, height: 900 });
  await win.waitForSelector('.textLayer span', { timeout: 20000 });
  const check = (c, m) => { if (!c) throw new Error('FAILED: ' + m); console.log('ok -', m); };
  const off = (i = 0) => win.evaluate((i) => { const e = app.panes[i].scrollEl; return { left: e.scrollLeft, mid: (e.scrollWidth - e.clientWidth) / 2, over: e.scrollWidth > e.clientWidth + 2, c: app.panes[i].hCenter }; }, i);
  const centred = (o) => !o.over || Math.abs(o.left - o.mid) <= 1;
  for (let k = 0; k < 6; k++) await win.evaluate(() => app.active.zoomBy(1.15));
  await win.waitForTimeout(400);
  let o = await off(); check(o.over && centred(o), 'zoomed in: centred ' + JSON.stringify(o));
  await win.keyboard.press('Control+j');
  await win.waitForTimeout(1200);
  o = await off(0); check(centred(o), 'after split, left pane centred ' + JSON.stringify(o));
  o = await off(1); check(centred(o), 'after split, right pane centred ' + JSON.stringify(o));
  await win.setViewportSize({ width: 1100, height: 900 });
  await win.waitForTimeout(600);
  o = await off(0); check(centred(o), 'after window resize, centred ' + JSON.stringify(o));
  // user scrolls sideways → stays where the user put it
  await win.evaluate(() => { app.panes[0].scrollEl.scrollLeft = 5; });
  await win.waitForTimeout(300);
  await win.evaluate(() => app.panes[0].zoomBy(1.1));
  await win.waitForTimeout(400);
  o = await off(0); check(!o.c && Math.abs(o.left - o.mid) > 5, 'manual sideways scroll is respected ' + JSON.stringify(o));
  await win.evaluate(() => app.panes[0].setZoom('fitWidth'));
  await win.waitForTimeout(400);
  o = await off(0); check(o.c && centred(o), 'fit width re-enables centring');
  await app.close();
})().catch(e => { console.error(e); process.exit(1); });
