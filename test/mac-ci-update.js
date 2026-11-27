// Runs on the macOS CI runner after the build: checks that the real update package works with the
// self-updater (latest-mac.yml checksums match the zips, `ditto` unpacks a runnable .app, swap works).
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto'), { execFileSync, spawnSync } = require('child_process');
const mac = require('../macupdate');
const dist = path.join(__dirname, '..', 'dist');
const version = require('../package.json').version;
const check = (c, m) => { if (!c) throw new Error('FAILED: ' + m); console.log('ok -', m); };
const meta = mac.parseLatestYml(fs.readFileSync(path.join(dist, 'latest-mac.yml'), 'utf8'));
check(meta.version === version, 'latest-mac.yml has version ' + version);
for (const arch of ['arm64', 'x64']) {
  const name = `PDF-Bat-${version}-${arch}-mac.zip`;
  const file = path.join(dist, name);
  check(fs.existsSync(file), name + ' built');
  const entry = meta.files.find(f => f.url === name);
  const sha = crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
  check(entry && entry.sha512 === sha && entry.size === fs.statSync(file).size, name + ': checksum in latest-mac.yml matches');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfbat-update-'));
  const unpack = path.join(root, 'app'); fs.mkdirSync(unpack);
  execFileSync('/usr/bin/ditto', ['-x', '-k', file, unpack]);
  const app = fs.readdirSync(unpack).find(n => n.endsWith('.app'));
  const plist = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(unpack, app, 'Contents', 'Info.plist')]).toString().trim();
  check(app === 'PDF-Bat.app' && plist === version, name + ': unpacks to PDF-Bat.app ' + plist);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', path.join(unpack, app)]);
  check(true, name + ': code signature intact after unpacking');
  // swap into a fake Applications folder
  const apps = fs.mkdtempSync(path.join(os.tmpdir(), 'apps-'));
  const old = path.join(apps, 'PDF-Bat.app'); fs.mkdirSync(path.join(old, 'Contents'), { recursive: true });
  const script = path.join(apps, 'swap.sh'); fs.writeFileSync(script, mac.swapScript(), { mode: 0o755 });
  spawnSync('/bin/sh', [script, '999999', old, path.join(unpack, app), '0']);
  const v2 = execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(old, 'Contents', 'Info.plist')]).toString().trim();
  check(v2 === version && !fs.existsSync(root), name + ': swapped into place, temp folder cleaned');
  fs.rmSync(apps, { recursive: true, force: true });
}
