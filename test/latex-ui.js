// LaTeX UI test with a fake engine (test/fakebin/pdflatex) so it runs without a TeX installation.
const { _electron: electron } = require('playwright');
const path = require('path'), fs = require('fs'), os = require('os');
const root = path.join(__dirname, '..');
const SHOTS = path.join(__dirname, 'shots');
(async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfbat-ud-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfbat-tex-'));
  const A = path.join(work, 'book.pdf');
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'book-plain.pdf'), A);
  const env = Object.assign({}, process.env, { PDFBAT_USERDATA: ud, PATH: path.join(__dirname, 'fakebin') + path.delimiter + process.env.PATH });
  const app = await electron.launch({ executablePath: require(path.join(root, 'node_modules', 'electron')), args: ['--no-sandbox', root, A], env });
  const win = await app.firstWindow();
  app.process().stderr.on('data', d => process.env.DEBUG && process.stderr.write('[main] ' + d));
  app.on('close', () => console.log('   (electron exited)'));
  const errors = [];
  win.on('pageerror', e => errors.push(e.message));
  win.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await win.setViewportSize({ width: 1400, height: 900 });
  const check = (c, msg) => { if (!c) throw new Error('FAILED: ' + msg); console.log('ok -', msg); };
  await win.waitForSelector('.textLayer span', { timeout: 20000 });
  check(await win.evaluate(() => !app._latex), 'LaTeX module not loaded in Read mode');
  await win.evaluate(() => app.setMode('edit'));
  // snippet on page
  await win.keyboard.press('l');
  const pg = await win.locator('.page[data-page="0"]').boundingBox();
  await win.mouse.click(pg.x + 120, pg.y + 520);
  await win.waitForSelector('.modal textarea.code');
  check(await win.evaluate(() => !!app._latex), 'LaTeX module loaded on first use in Edit mode');
  await win.keyboard.type('E = mc^2');
  await win.waitForSelector('.modal .preview img', { timeout: 15000 });
  await win.screenshot({ path: path.join(SHOTS, '10-latex-snippet.png') });
  await win.click('.modal .foot .primary');
  await win.waitForTimeout(500);
  const ed = await win.evaluate(() => app.active.doc.edits.map(e => e.type + ':' + e.src));
  check(ed.length === 1 && ed[0] === 'latex:E = mc^2', 'LaTeX object placed: ' + ed);
  await win.evaluate(() => app.save());
  await win.waitForTimeout(1500);
  check(await win.evaluate(() => app.active.doc.edits.length === 0), 'LaTeX flattened into the PDF on save');
  // full document
  win.evaluate(() => app.newTex());
  await win.waitForSelector('.modal .list .entry');
  await win.click('.modal .foot .primary');
  await win.waitForSelector('.texpane');
  await win.waitForFunction(() => app.panes.some(p => p.doc && p.doc.isPreview), null, { timeout: 15000 });
  check(true, 'new document compiled and preview opened');
  // error reporting
  await win.evaluate(() => { const t = app.panes.find(p => p.isTex); t.ta.value = t.ta.value.replace('\\maketitle', '\\maketitle\n\\undefinedmacro'); t.ta.dispatchEvent(new Event('input')); return t.compile(true); });
  await win.waitForSelector('.tex-log .err', { timeout: 10000 });
  const errText = await win.locator('.tex-log .err').first().textContent();
  check(/Undefined control sequence/.test(errText), 'compile error shown: ' + errText);
  await win.screenshot({ path: path.join(SHOTS, '11-latex-document.png') });
  check(errors.length === 0, 'no renderer errors ' + errors.join('\n'));
  await app.evaluate(({ app }) => app.exit(0));
})().catch(e => { console.error(e); process.exit(1); });
