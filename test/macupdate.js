// macOS self-update helpers (runs with plain node, no Electron needed):
// latest-mac.yml parsing, asset choice, bundle checks, and the swap script on fake .app folders.
const fs = require('fs'), os = require('os'), path = require('path'), { spawnSync, spawn } = require('child_process');
const mac = require('../macupdate');
const check = (c, m) => { if (!c) throw new Error('FAILED: ' + m); console.log('ok -', m); };

const yml = `version: 0.4.2
files:
  - url: PDF-Bat-0.4.2-arm64-mac.zip
    sha512: AAA+/==
    size: 101
  - url: PDF-Bat-0.4.2-x64-mac.zip
    sha512: BBB==
    size: 202
  - url: PDF-Bat-0.4.2-arm64.dmg
    sha512: CCC==
    size: 303
path: PDF-Bat-0.4.2-arm64-mac.zip
sha512: AAA+/==
releaseDate: '2026-11-27T10:00:00.000Z'
`;
const m = mac.parseLatestYml(yml);
check(m.version === '0.4.2' && m.files.length === 3, 'latest-mac.yml parsed');
check(m.files[1].url === 'PDF-Bat-0.4.2-x64-mac.zip' && m.files[1].sha512 === 'BBB==' && m.files[1].size === 202, 'checksum and size per file');
const assets = ['PDF-Bat-0.4.2-arm64.dmg', 'PDF-Bat-0.4.2-arm64-mac.zip', 'PDF-Bat-0.4.2-x64-mac.zip'].map(name => ({ name }));
check(mac.pickZip(assets, 'arm64').name === 'PDF-Bat-0.4.2-arm64-mac.zip' && mac.pickZip(assets, 'x64').name === 'PDF-Bat-0.4.2-x64-mac.zip', 'right zip for each architecture');
check(mac.appBundlePath('/Applications/PDF-Bat.app/Contents/MacOS/PDF-Bat') === '/Applications/PDF-Bat.app', 'bundle path from executable');
check(!mac.canSelfUpdate('/Volumes/PDF-Bat 0.4.1/PDF-Bat.app') && !mac.canSelfUpdate('/private/var/folders/x/AppTranslocation/1/d/PDF-Bat.app') && !mac.canSelfUpdate(null), 'no self-update from the .dmg or a translocated copy');

// swap script on fake bundles
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mu-'));
const apps = path.join(root, 'Applications'); fs.mkdirSync(apps);
const old = path.join(apps, 'PDF-Bat.app'); fs.mkdirSync(path.join(old, 'Contents'), { recursive: true }); fs.writeFileSync(path.join(old, 'Contents', 'v'), '0.4.1');
check(mac.canSelfUpdate(old), 'writable bundle can self-update');
const upd = path.join(root, 'pdfbat-update-x'); const neu = path.join(upd, 'app', 'PDF-Bat.app');
fs.mkdirSync(path.join(neu, 'Contents'), { recursive: true }); fs.writeFileSync(path.join(neu, 'Contents', 'v'), '0.4.2');
const script = path.join(root, 'swap.sh'); fs.writeFileSync(script, mac.swapScript(), { mode: 0o755 });
// a fake "PDF-Bat" process the script must wait for
const fake = spawn('sleep', ['1']);
const t0 = Date.now();
const r = spawnSync('/bin/sh', [script, String(fake.pid), old, neu, '0']);
check(r.status === 0 && Date.now() - t0 >= 800, 'script waits for the app to quit');
check(fs.readFileSync(path.join(old, 'Contents', 'v'), 'utf8') === '0.4.2', 'new version is in place');
check(!fs.existsSync(old + '.pdfbat-old') && !fs.existsSync(upd), 'backup and download folder removed');

// failed move → old app restored
const old2 = path.join(apps, 'Two.app'); fs.mkdirSync(old2); fs.writeFileSync(path.join(old2, 'v'), 'old');
spawnSync('/bin/sh', [script, '999999', old2, path.join(root, 'missing', 'app', 'X.app'), '0']);
check(fs.readFileSync(path.join(old2, 'v'), 'utf8') === 'old', 'if the new app is missing, the old one stays');
fs.rmSync(root, { recursive: true, force: true });
