// Smoke test: launch the real app with Playwright's Electron driver and exercise the main features.
const { _electron: electron } = require('playwright');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SHOTS = process.env.SHOTS || path.join(__dirname, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const root = path.join(__dirname, '..');

async function main() {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfbat-ud-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfbat-work-'));
  for (const f of ['book-bookmarks.pdf', 'book-plain.pdf']) fs.copyFileSync(path.join(__dirname, 'fixtures', f), path.join(work, f));
  const A = path.join(work, 'book-bookmarks.pdf'), B = path.join(work, 'book-plain.pdf');
  const launch = () => electron.launch({ executablePath: require(path.join(root, 'node_modules', 'electron')), args: ['--no-sandbox', root, A], env: Object.assign({}, process.env, { PDFBAT_USERDATA: ud }) });
  let app = await launch();
  let win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', e => errors.push('pageerror: ' + e.message));
  win.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await win.setViewportSize({ width: 1400, height: 900 });
  await win.waitForSelector('.page canvas.pc', { timeout: 20000 });
  await win.waitForSelector('.textLayer span', { timeout: 20000 });
  const check = (c, msg) => { if (!c) throw new Error('FAILED: ' + msg); console.log('ok -', msg); };

  check(await win.locator('.pane').count() === 1, 'one pane opened from argv');
  await win.waitForSelector('.outline .item', { timeout: 20000 });
  const items = await win.locator('.outline .item').count();
  check(items >= 15, `outline from bookmarks (${items} items)`);
  await win.screenshot({ path: path.join(SHOTS, '01-read-dark.png') });

  // outline navigation
  await win.locator('.outline .item', { hasText: 'Chapter 3' }).first().click();
  await win.waitForTimeout(400);
  const cur = await win.evaluate(() => app.active.current);
  check(cur === 12, `outline click goes to chapter 3 (page index ${cur})`);

  // highlight via selection with highlight tool
  await win.keyboard.press('a');
  const span = win.locator('.page[data-page="12"] .textLayer span').nth(3);
  const box = await span.boundingBox();
  await win.mouse.move(box.x + 2, box.y + box.height / 2);
  await win.mouse.down();
  await win.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 5 });
  await win.mouse.up();
  await win.waitForTimeout(300);
  let n = await win.evaluate(() => app.active.doc.annotations.length);
  check(n === 1, 'highlight created');

  // pen stroke
  await win.keyboard.press('p');
  const pg = await win.locator('.page[data-page="12"]').boundingBox();
  await win.mouse.move(pg.x + 100, pg.y + 400);
  await win.mouse.down();
  for (let i = 0; i < 20; i++) await win.mouse.move(pg.x + 100 + i * 10, pg.y + 400 + Math.sin(i / 3) * 20);
  await win.mouse.up();
  await win.waitForTimeout(200);
  // sticky note
  await win.keyboard.press('n');
  await win.mouse.click(pg.x + 300, pg.y + 300);
  await win.waitForSelector('.note-pop textarea');
  await win.keyboard.type('Check the sign of torque here');
  await win.keyboard.press('Control+Enter');
  await win.waitForTimeout(200);
  n = await win.evaluate(() => app.active.doc.annotations.map(a => a.type).join(','));
  check(n === 'highlight,ink,note', 'pen + note created: ' + n);
  await win.screenshot({ path: path.join(SHOTS, '02-annotations.png') });

  // wait for autosave into the PDF
  await win.waitForTimeout(2500);
  // duplicate pane
  await win.keyboard.press('v');
  await win.evaluate(() => app.duplicatePane(app.active));
  await win.waitForTimeout(800);
  check(await win.locator('.pane').count() === 2, 'duplicated into two panes');
  await win.evaluate(() => app.panes[1].goto(25));
  await win.waitForTimeout(500);
  // open second file
  await win.evaluate((p) => app.openPaths([p]), B);
  await win.waitForTimeout(1500);
  check(await win.locator('.pane').count() === 3, 'three panes side by side');
  await win.evaluate(() => app.setActive(app.panes[2]));
  await win.waitForSelector('.outline .item', { timeout: 20000 });
  const det = await win.evaluate(() => Array.from(document.querySelectorAll('.outline .item .t')).map(e => e.textContent));
  console.log('   detected outline:', det.slice(0, 6).join(' | '), '… total', det.length);
  check(det.some(t => /Chapter 2/.test(t)) && det.some(t => /2\.1 Section/.test(t)) && !det.some(t => /Running header/.test(t)), 'heuristic outline on plain PDF');
  // find
  await win.keyboard.press('Control+f');
  await win.keyboard.type('moment of inertia');
  await win.keyboard.press('Enter');
  await win.waitForTimeout(1200);
  const marks = await win.locator('.hit-mark').count();
  console.log('   find state:', JSON.stringify(await win.evaluate(() => ({ bar: !!app.findBar, val: app.findInput && app.findInput.value, f: app.active.find && { q: app.active.find.q, n: app.active.find.pages.length, idx: app.active.find.idx, done: app.active.find.done }, cur: app.active.current }))));
  check(marks > 0, `find highlights matches (${marks})`);
  await win.keyboard.press('Escape');
  // light theme + dark pages screenshot
  await win.evaluate(() => app.toggleTheme());
  await win.waitForTimeout(300);
  await win.screenshot({ path: path.join(SHOTS, '03-three-panes-light.png') });
  await win.evaluate(() => app.toggleTheme());

  // edit mode: add text and whiteout, save
  await win.evaluate(() => app.setActive(app.panes[2]));
  await win.evaluate(() => app.setMode('edit'));
  await win.waitForTimeout(500);
  await win.screenshot({ path: path.join(SHOTS, '04-edit-mode.png') });
  await win.keyboard.press('t');
  const pg2 = await win.locator('.pane >> nth=2 >> .page >> nth=0').boundingBox();
  await win.mouse.click(pg2.x + 80, pg2.y + 300);
  await win.waitForTimeout(200);
  await win.keyboard.type('Added by PDF-Bat — тест');
  await win.mouse.click(pg2.x + 400, pg2.y + 700);
  await win.waitForTimeout(200);
  // edit existing text
  await win.keyboard.press('r');
  const sp = win.locator('.pane >> nth=2 >> .page[data-page="0"] .textLayer span').first();
  await sp.click();
  await win.waitForTimeout(200);
  await win.keyboard.type('Edited heading');
  await win.keyboard.press('Control+Enter');
  await win.waitForTimeout(200);
  const edits = await win.evaluate(() => app.panes[2].doc.edits.map(e => e.type + ':' + (e.text || '')));
  check(edits.length === 2, 'edit objects: ' + edits.join(' / '));
  // rotate page 2 and save
  await win.evaluate(() => app.editor.pageOp('rotate', [1]));
  await win.waitForTimeout(800);
  await win.evaluate(() => app.save());
  await win.waitForTimeout(2000);
  await win.screenshot({ path: path.join(SHOTS, '05-after-save.png') });
  check(errors.length === 0, 'no renderer errors' + (errors.length ? ':\n' + errors.join('\n') : ''));
  // close & reopen: last page + annotations restored from the PDF itself
  const lastBefore = await win.evaluate(() => app.panes[0].current);
  await win.evaluate(() => app.panes[0].saveViewState.flush());
  await win.waitForTimeout(500);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await app.waitForEvent('close').catch(() => {});
  app = await launch();
  win = await app.firstWindow();
  await win.waitForSelector('.page canvas.pc', { timeout: 20000 });
  await win.waitForTimeout(1500);
  const st = await win.evaluate(() => ({ panes: app.panes.length, cur: app.panes[0].current, ann: app.panes[0].doc.annotations.map(a => a.type).join(',') }));
  console.log('   after restart:', JSON.stringify(st), 'lastBefore', lastBefore);
  check(st.panes >= 3 && st.cur === lastBefore, 'session + last page restored');
  check(st.ann === 'highlight,ink,note', 'annotations read back from the PDF file');
  await win.screenshot({ path: path.join(SHOTS, '06-restored.png') });
  await app.close();
  // verify with an external parser that the annotations really are in the PDF
  console.log('PDF:', A);
  fs.writeFileSync(path.join(SHOTS, 'paths.json'), JSON.stringify({ A, B }));
}
main().catch(e => { console.error(e); process.exit(1); });
