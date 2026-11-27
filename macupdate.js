'use strict';
// Self-update for the macOS build without an Apple Developer signature.
// Apple's own updater (Squirrel.Mac) needs a paid signing identity, so PDF-Bat does it itself:
//   1. download PDF-Bat-<version>-<arch>-mac.zip from the GitHub release (in the background)
//   2. check its SHA-512 against latest-mac.yml from the same release
//   3. unpack it with `ditto` (keeps the app bundle's symlinks and permissions)
//   4. after PDF-Bat quits, a small shell script swaps the old .app for the new one (and relaunches it)
// Anything unusual (app not in a writable folder, running from the .dmg, App Translocation) → null,
// and the caller falls back to offering the .dmg download.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { net } = require('electron');

// /Applications/PDF-Bat.app/Contents/MacOS/PDF-Bat → /Applications/PDF-Bat.app
function appBundlePath(execPath = process.execPath) {
  const p = path.resolve(execPath, '..', '..', '..');
  return p.endsWith('.app') ? p : null;
}

function canSelfUpdate(bundle) {
  if (!bundle) return false;
  if (bundle.startsWith('/Volumes/')) return false;              // running from the mounted .dmg
  if (bundle.includes('/AppTranslocation/')) return false;       // macOS ran it from a read-only copy
  try { fs.accessSync(path.dirname(bundle), fs.constants.W_OK); fs.accessSync(bundle, fs.constants.W_OK); return true; } catch (e) { return false; }
}

// tiny parser for electron-builder's latest-mac.yml: files: - url / sha512 / size
function parseLatestYml(text) {
  const files = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if ((m = line.match(/^\s*-\s+url:\s*(.+)$/))) { cur = { url: unq(m[1]) }; files.push(cur); continue; }
    if (cur && (m = line.match(/^\s+sha512:\s*(.+)$/))) cur.sha512 = unq(m[1]);
    else if (cur && (m = line.match(/^\s+size:\s*(\d+)/))) cur.size = +m[1];
    else if (/^\S/.test(line)) cur = null;
  }
  const version = (text.match(/^version:\s*(.+)$/m) || [])[1];
  return { version: version && unq(version), files };
}
function unq(s) { return s.trim().replace(/^['"]|['"]$/g, ''); }

function pickZip(assets, arch) {
  return assets.find(a => a.name.endsWith(`-${arch}-mac.zip`)) || null;
}

function download(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, redirect: 'follow', headers: { 'User-Agent': 'PDF-Bat' } });
    const out = fs.createWriteStream(dest);
    const hash = crypto.createHash('sha512');
    let got = 0, total = 0;
    req.on('response', (res) => {
      if (res.statusCode !== 200) { out.destroy(); reject(new Error('HTTP ' + res.statusCode)); return; }
      total = +(res.headers['content-length'] || 0);
      res.on('data', (d) => { got += d.length; hash.update(d); out.write(d); if (onProgress && total) onProgress(got / total); });
      res.on('end', () => out.end(() => resolve({ size: got, sha512: hash.digest('base64') })));
      res.on('error', (e) => { out.destroy(); reject(e); });
    });
    req.on('error', (e) => { out.destroy(); reject(e); });
    req.end();
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, redirect: 'follow', headers: { 'User-Agent': 'PDF-Bat' } });
    let body = '';
    req.on('response', (res) => {
      res.on('data', (d) => { body += d; });
      res.on('end', () => res.statusCode === 200 ? resolve(body) : reject(new Error('HTTP ' + res.statusCode)));
    });
    req.on('error', reject);
    req.end();
  });
}

const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, (e, so, se) => e ? reject(new Error(se || e.message)) : resolve(so)));

// Download + verify + unpack. Returns the path of the new .app (ready to swap in), or throws.
async function prepare(rel, arch, onProgress) {
  const assets = rel.assets || [];
  const zip = pickZip(assets, arch);
  const yml = assets.find(a => a.name === 'latest-mac.yml');
  if (!zip || !yml) throw new Error('no macOS update package in this release');
  const meta = parseLatestYml(await fetchText(yml.browser_download_url));
  const expect = meta.files.find(f => path.basename(f.url) === zip.name);
  if (!expect || !expect.sha512) throw new Error('no checksum for ' + zip.name);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfbat-update-'));
  const file = path.join(dir, zip.name);
  const got = await download(zip.browser_download_url, file, onProgress);
  if (got.sha512 !== expect.sha512 || (expect.size && got.size !== expect.size)) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('downloaded update is damaged (checksum mismatch)');
  }
  const unpack = path.join(dir, 'app');
  fs.mkdirSync(unpack);
  await run('/usr/bin/ditto', ['-x', '-k', file, unpack]);
  const app = fs.readdirSync(unpack).find(n => n.endsWith('.app'));
  if (!app) throw new Error('update package has no app inside');
  fs.rmSync(file, { force: true });
  return path.join(unpack, app);
}

// Shell script that waits for this process to exit, then swaps the bundles. Old app is kept until the
// new one is in place, and restored if the move fails.
function swapScript() {
  return `#!/bin/sh
PID="$1"; OLD="$2"; NEW="$3"; RELAUNCH="$4"
i=0; while kill -0 "$PID" 2>/dev/null && [ $i -lt 300 ]; do sleep 0.2; i=$((i+1)); done
BAK="$OLD.pdfbat-old"
rm -rf "$BAK"
if mv "$OLD" "$BAK"; then
  if mv "$NEW" "$OLD"; then
    rm -rf "$BAK"
    xattr -dr com.apple.quarantine "$OLD" 2>/dev/null
  else
    mv "$BAK" "$OLD"
  fi
fi
TMP="$(dirname "$(dirname "$NEW")")"
case "$(basename "$TMP")" in pdfbat-update-*) rm -rf "$TMP";; esac
if [ "$RELAUNCH" = "1" ]; then open "$OLD"; fi
`;
}

function scheduleSwap(newApp, relaunch, bundle = appBundlePath()) {
  const script = path.join(os.tmpdir(), `pdfbat-swap-${process.pid}.sh`);
  fs.writeFileSync(script, swapScript(), { mode: 0o755 });
  const child = spawn('/bin/sh', [script, String(process.pid), bundle, newApp, relaunch ? '1' : '0'], { detached: true, stdio: 'ignore' });
  child.unref();
}

module.exports = { appBundlePath, canSelfUpdate, parseLatestYml, pickZip, prepare, scheduleSwap, swapScript };
