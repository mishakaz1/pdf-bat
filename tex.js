'use strict';
// LaTeX engine management (main process). Only used from Edit mode.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { execFile, spawn } = require('child_process');

const TECTONIC_VERSION = '0.15.0';
const isWin = process.platform === 'win32';
const exe = (n) => (isWin ? n + '.exe' : n);

function tectonicDir() { return path.join(app.getPath('userData'), 'tectonic'); }
function bundledTectonic() { return path.join(tectonicDir(), exe('tectonic')); }

function extraPathDirs() {
  if (process.platform === 'darwin') return ['/Library/TeX/texbin', '/opt/homebrew/bin', '/usr/local/bin'];
  if (isWin) {
    const pf = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], 'Programs')].filter(Boolean);
    const dirs = [];
    for (const p of pf) {
      dirs.push(path.join(p, 'MiKTeX', 'miktex', 'bin', 'x64'));
      dirs.push(path.join(p, 'MiKTeX', 'miktex', 'bin'));
    }
    try {
      for (const y of fs.readdirSync('C:\\texlive')) dirs.push(path.join('C:\\texlive', y, 'bin', 'windows'), path.join('C:\\texlive', y, 'bin', 'win64'), path.join('C:\\texlive', y, 'bin', 'win32'));
    } catch (_) {}
    return dirs;
  }
  return ['/usr/bin', '/usr/local/bin', '/usr/local/texlive/bin/x86_64-linux'];
}

function findOnPath(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).concat(extraPathDirs());
  for (const d of dirs) {
    if (!d) continue;
    const p = path.join(d, exe(name));
    try { if (fs.statSync(p).isFile()) return p; } catch (_) {}
  }
  return null;
}

// Returns list of available engines: [{id, name, path}]
function detectEngines() {
  const out = [];
  const b = bundledTectonic();
  if (fs.existsSync(b)) out.push({ id: 'tectonic-bundled', kind: 'tectonic', name: 'Tectonic (built-in)', path: b });
  const t = findOnPath('tectonic');
  if (t) out.push({ id: 'tectonic', kind: 'tectonic', name: 'Tectonic (system)', path: t });
  for (const n of ['pdflatex', 'xelatex', 'lualatex']) {
    const p = findOnPath(n);
    if (p) out.push({ id: n, kind: 'latex', name: n + ' (system)', path: p });
  }
  return out;
}

function tectonicAsset() {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
  if (process.platform === 'darwin') return `tectonic-${TECTONIC_VERSION}-${arch}-apple-darwin.tar.gz`;
  if (isWin) return `tectonic-${TECTONIC_VERSION}-x86_64-pc-windows-msvc.zip`;
  return `tectonic-${TECTONIC_VERSION}-${arch}-unknown-linux-musl.tar.gz`;
}

function download(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'PDF-Bat' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 8) {
        res.resume();
        resolve(download(new URL(res.headers.location, url).toString(), dest, onProgress, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      const total = Number(res.headers['content-length']) || 0;
      let got = 0;
      const f = fs.createWriteStream(dest);
      res.on('data', (c) => { got += c.length; if (onProgress) onProgress(got, total); });
      res.pipe(f);
      f.on('finish', () => f.close(() => resolve(dest)));
      f.on('error', reject);
    }).on('error', reject);
  });
}

async function installTectonic(onProgress) {
  const dir = tectonicDir();
  fs.mkdirSync(dir, { recursive: true });
  const asset = tectonicAsset();
  const url = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/${asset}`;
  const archive = path.join(dir, asset);
  await download(url, archive, onProgress);
  // bsdtar ships with macOS and Windows 10+ and handles both .tar.gz and .zip
  await new Promise((resolve, reject) => {
    execFile('tar', ['-xf', archive, '-C', dir], (err) => (err ? reject(err) : resolve()));
  });
  fs.unlinkSync(archive);
  const bin = bundledTectonic();
  if (!fs.existsSync(bin)) throw new Error('tectonic binary not found after extraction');
  if (!isWin) fs.chmodSync(bin, 0o755);
  return bin;
}

function run(cmd, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let log = '';
    const p = spawn(cmd, args, { cwd, env: Object.assign({}, process.env, { PATH: [path.dirname(cmd), process.env.PATH].join(path.delimiter) }) });
    const timer = setTimeout(() => { log += '\n[PDF-Bat] compilation timed out\n'; p.kill(); }, timeoutMs);
    p.stdout.on('data', (d) => { log += d; });
    p.stderr.on('data', (d) => { log += d; });
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, log: log + '\n' + e.message }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, log }); });
  });
}

// Compile LaTeX source. opts: {engine (path), kind, workDir?, jobName?, passes?}
async function compile(source, opts) {
  const dir = opts.workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'pdfbat-tex-'));
  const job = opts.jobName || 'pdfbat';
  const texFile = path.join(dir, job + '.tex');
  fs.writeFileSync(texFile, source, 'utf8');
  const pdfFile = path.join(dir, job + '.pdf');
  try { fs.unlinkSync(pdfFile); } catch (_) {}
  let res;
  if (opts.kind === 'tectonic') {
    res = await run(opts.engine, ['--keep-logs', '--outdir', dir, texFile], dir, 300000);
  } else {
    const passes = opts.passes || 1;
    for (let i = 0; i < passes; i++) {
      res = await run(opts.engine, ['-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-output-directory', dir, texFile], dir, 180000);
      if (res.code !== 0) break;
    }
  }
  const ok = fs.existsSync(pdfFile);
  const data = ok ? fs.readFileSync(pdfFile) : null;
  // pdflatex/xelatex write their messages into the .log file; include it for error parsing
  let log = res.log;
  try { if (opts.kind !== 'tectonic') log = fs.readFileSync(path.join(dir, job + '.log'), 'latin1'); } catch (_) {}
  if (!opts.workDir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
  return { ok: ok && res.code === 0, data, log, code: res.code, pdfPath: opts.workDir ? pdfFile : null };
}

function scratchDir(id) {
  const d = path.join(app.getPath('userData'), 'tex-scratch', String(id).replace(/[^\w-]/g, ''));
  fs.mkdirSync(d, { recursive: true });
  return d;
}

module.exports = { detectEngines, installTectonic, compile, scratchDir };
