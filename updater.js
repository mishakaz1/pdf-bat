'use strict';
// Automatic updates from GitHub Releases.
//  * Windows: downloads the new installer in the background and installs it on quit (electron-updater).
//  * macOS: the app is not signed by Apple yet, and macOS refuses to auto-replace unsigned apps,
//    so we check GitHub, tell the user, and download the right .dmg with one click.
const { app, dialog, shell, net } = require('electron');

const OWNER = 'mishakaz1', REPO = 'pdf-bat';
const SIX_HOURS = 6 * 3600 * 1000;

function cmp(a, b) {
  const pa = a.replace(/^v/, '').split('.').map(Number), pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, headers: { 'User-Agent': 'PDF-Bat', Accept: 'application/vnd.github+json' } });
    let body = '';
    req.on('response', (res) => {
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { if (res.statusCode !== 200) throw new Error('HTTP ' + res.statusCode); resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function setup({ getWindow, store, saveStore, send }) {
  let winUpdater = null;
  const state = { status: 'idle', version: null };
  const notify = (patch) => { Object.assign(state, patch); send('update-status', state); };

  if (process.platform === 'win32') {
    try {
      winUpdater = require('electron-updater').autoUpdater;
      winUpdater.autoDownload = true;
      winUpdater.autoInstallOnAppQuit = true;
      winUpdater.on('update-available', (i) => notify({ status: 'downloading', version: i.version }));
      winUpdater.on('download-progress', (p) => notify({ status: 'downloading', percent: Math.round(p.percent) }));
      winUpdater.on('update-not-available', () => notify({ status: 'latest' }));
      winUpdater.on('error', (e) => notify({ status: 'error', error: String(e && e.message || e) }));
      winUpdater.on('update-downloaded', async (i) => {
        notify({ status: 'ready', version: i.version });
        const r = await dialog.showMessageBox(getWindow(), {
          type: 'info', message: `PDF-Bat ${i.version} is ready`,
          detail: 'Restart now to update, or it will be installed when you quit.',
          buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1
        });
        if (r.response === 0) { app.emit('pdfbat-before-update'); setImmediate(() => winUpdater.quitAndInstall(false, true)); }
      });
    } catch (e) { console.error('electron-updater unavailable', e); }
  }

  async function checkMac(manual) {
    const rel = await fetchJson(`https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`);
    const latest = rel.tag_name;
    if (cmp(latest, app.getVersion()) <= 0) {
      notify({ status: 'latest' });
      if (manual) dialog.showMessageBox(getWindow(), { type: 'info', message: 'PDF-Bat is up to date', detail: `Version ${app.getVersion()}` });
      return;
    }
    notify({ status: 'available', version: latest });
    if (!manual && store.settings.skipVersion === latest) return;
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const asset = (rel.assets || []).find(a => a.name.endsWith(`-${arch}.dmg`)) || (rel.assets || []).find(a => a.name.endsWith('.dmg'));
    const notes = (rel.body || '').replace(/\r/g, '').split('\n').filter(l => l.trim()).slice(0, 12).join('\n');
    const r = await dialog.showMessageBox(getWindow(), {
      type: 'info', message: `PDF-Bat ${latest.replace(/^v/, '')} is available`,
      detail: `You have ${app.getVersion()}.\n\n${notes}\n\nDownload opens the new .dmg; drag PDF-Bat into Applications and replace the old one.`,
      buttons: ['Download', 'Later', 'Skip this version'], defaultId: 0, cancelId: 1
    });
    if (r.response === 0) shell.openExternal(asset ? asset.browser_download_url : rel.html_url);
    if (r.response === 2) { store.settings.skipVersion = latest; saveStore(); }
  }

  async function check(manual) {
    if (!app.isPackaged && !process.env.PDFBAT_TEST_UPDATES) {
      if (manual) dialog.showMessageBox(getWindow(), { type: 'info', message: 'Updates are checked in the installed app only.' });
      return;
    }
    try {
      if (winUpdater) {
        notify({ status: 'checking' });
        const r = await winUpdater.checkForUpdates();
        if (manual && (!r || !r.updateInfo || cmp(r.updateInfo.version, app.getVersion()) <= 0)) {
          dialog.showMessageBox(getWindow(), { type: 'info', message: 'PDF-Bat is up to date', detail: `Version ${app.getVersion()}` });
        } else if (manual) {
          dialog.showMessageBox(getWindow(), { type: 'info', message: `Downloading PDF-Bat ${r.updateInfo.version}…`, detail: 'You will be asked to restart when it is ready.' });
        }
      } else {
        await checkMac(manual);
      }
    } catch (e) {
      notify({ status: 'error', error: String(e.message || e) });
      if (manual) dialog.showMessageBox(getWindow(), { type: 'warning', message: 'Could not check for updates', detail: String(e.message || e) });
    }
  }

  setTimeout(() => check(false), 8000);
  setInterval(() => check(false), SIX_HOURS);
  return { check, state };
}

module.exports = { setup, cmp };
