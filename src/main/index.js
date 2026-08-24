'use strict';

const fs = require('fs');
const path = require('path');
const {
  app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, shell, dialog,
  nativeImage, session: electronSession,
} = require('electron');

const store = require('./store');
const openai = require('./openai');
const local = require('./local');

const IS_DEV = process.argv.includes('--dev');
const ASSETS = path.join(__dirname, '..', '..', 'assets');

let win = null;
let tray = null;
let quitting = false;
let translationActive = false;

// --------------------------------------------------------------- lifecycle --

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
}

app.setAppUserModelId('com.bbuldakovv.voiceb');

app.whenReady().then(() => {
  grantAudioPermissions();
  createWindow();
  createTray();
  registerHotkeys(store.getSettings());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  if (win && !win.isDestroyed()) win.webContents.send('app:before-quit');
});

app.on('will-quit', () => globalShortcut.unregisterAll());

// ------------------------------------------------------------------ window --

function createWindow() {
  const settings = store.getSettings();
  const bounds = settings.windowBounds || {};

  win = new BrowserWindow({
    width: bounds.width || 460,
    height: bounds.height || 900,
    x: bounds.x,
    y: bounds.y,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: '#0b0f16',
    icon: path.join(ASSETS, 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  if (IS_DEV) {
    win.webContents.openDevTools({ mode: 'detach' });
    // Mirror renderer console into the terminal — Electron 43 passes a single
    // event object, older builds pass positional arguments.
    win.webContents.on('console-message', (...args) => {
      const e = args[0];
      const message = e && typeof e === 'object' ? e.message : args[1];
      const source = e && typeof e === 'object' ? `${e.sourceId}:${e.lineNumber}` : `${args[3]}:${args[2]}`;
      console.log(`[renderer] ${message}  (${source})`);
    });
  }

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] process gone:', details.reason);
  });

  win.on('close', (event) => {
    if (!quitting && store.getSettings().minimizeToTray) {
      event.preventDefault();
      win.hide();
      return;
    }
    saveBounds();
  });

  win.on('moved', saveBounds);
  win.on('resized', saveBounds);

  // Keep external links out of the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function saveBounds() {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  store.setSettings({ windowBounds: win.getNormalBounds() });
}

function showWindow() {
  if (!win || win.isDestroyed()) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * Electron gates getUserMedia and setSinkId behind permission prompts that have
 * no UI in a desktop shell, so grant them up front for our own pages.
 */
function grantAudioPermissions() {
  const allowed = new Set(['media', 'audioCapture', 'speaker-selection']);
  const ses = electronSession.defaultSession;
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
}

// -------------------------------------------------------------------- tray --

function createTray() {
  const image = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
  tray = new Tray(image);
  tray.setToolTip('VoiceB - idle');
  tray.on('click', showWindow);
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show VoiceB', click: showWindow },
    { type: 'separator' },
    {
      label: 'Toggle mute',
      enabled: translationActive,
      click: () => win && win.webContents.send('tray:toggle-mute'),
    },
    {
      label: 'Stop translation',
      enabled: translationActive,
      click: () => win && win.webContents.send('tray:stop'),
    },
    { type: 'separator' },
    { label: 'Open data folder', click: () => shell.openPath(store.userDir()) },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.setToolTip(translationActive ? 'VoiceB - translating' : 'VoiceB - idle');
}

// ---------------------------------------------------------------- hotkeys --

function registerHotkeys(settings) {
  globalShortcut.unregisterAll();
  const results = {};

  const bind = (accelerator, name, handler) => {
    if (!accelerator) return;
    try {
      results[name] = globalShortcut.register(accelerator, handler);
    } catch {
      results[name] = false;
    }
  };

  bind(settings.hotkeyToggleMute, 'toggleMute', () => win && win.webContents.send('hotkey:toggle-mute'));
  bind(settings.hotkeyShowWindow, 'showWindow', showWindow);
  return results;
}

// -------------------------------------------------------------------- IPC --

ipcMain.handle('settings:get', () => store.getSettings());

ipcMain.handle('settings:set', (_e, patch) => {
  const next = store.setSettings(patch || {});
  if (patch && ('hotkeyToggleMute' in patch || 'hotkeyShowWindow' in patch)) {
    registerHotkeys(next);
  }
  return next;
});

ipcMain.handle('key:status', () => ({
  present: store.hasApiKey(),
  encrypted: store.encryptionAvailable(),
}));

ipcMain.handle('key:set', (_e, value) => {
  store.setApiKey((value || '').trim());
  return { present: store.hasApiKey(), encrypted: store.encryptionAvailable() };
});

ipcMain.handle('key:verify', async () => {
  const key = store.getApiKey();
  if (!key) return { ok: false, reason: 'missing', detail: 'No API key saved.' };
  try {
    return await openai.verifyKey(key);
  } catch (err) {
    return { ok: false, reason: 'network', detail: err.message };
  }
});

ipcMain.handle('session:secret', async (_e, options) => {
  const key = store.getApiKey();
  if (!key) throw new Error('No API key saved. Open Settings and add one.');
  return openai.createClientSecret(key, options || {});
});

ipcMain.handle('session:sdp', (_e, payload) =>
  openai.exchangeSdp(payload.clientSecret, payload.offerSdp));

ipcMain.handle('session:price', () => openai.USD_PER_MINUTE);

ipcMain.handle('history:list', () => store.listHistory());
ipcMain.handle('history:read', (_e, id) => store.readSession(id));
ipcMain.handle('history:save', (_e, session) => store.saveSession(session));
ipcMain.handle('history:delete', (_e, id) => store.deleteSession(id));

ipcMain.handle('history:export', async (_e, payload) => {
  const session = store.readSession(payload.id);
  if (!session) throw new Error('Session not found');

  const format = payload.format;
  const stamp = new Date(session.startedAt || Date.now())
    .toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const ext = format === 'json' ? 'json' : format === 'md' ? 'md' : 'txt';

  const result = await dialog.showSaveDialog(win, {
    title: 'Export transcript',
    defaultPath: path.join(app.getPath('documents'), `voiceb-${stamp}.${ext}`),
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
  if (result.canceled || !result.filePath) return { saved: false };

  fs.writeFileSync(result.filePath, renderTranscript(session, ext), 'utf8');
  return { saved: true, filePath: result.filePath };
});

// The local engine narrates long jobs — pip installs, model downloads — so the
// Setup panel can show something other than a spinner for ten minutes.
local.setEventSink((payload) => {
  if (win && !win.isDestroyed()) win.webContents.send('local:progress', payload);
});

ipcMain.handle('local:probe', () => local.probe());
ipcMain.handle('local:probe-gpu', () => local.probeGpu());
ipcMain.handle('local:setup', (_e, options) => local.setup(options || {}));
ipcMain.handle('local:download', (_e, options) => local.download(options || {}));
ipcMain.handle('local:start', () => local.start());
ipcMain.handle('local:stop', () => local.stop());
ipcMain.handle('local:status', () => local.status());

ipcMain.handle('system:info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  dataDir: store.userDir(),
  model: openai.MODEL,
  transcribeModel: openai.TRANSCRIBE_MODEL,
  outputLanguages: openai.OUTPUT_LANGUAGES,
}));

ipcMain.handle('system:cables', () => detectCables());
ipcMain.handle('system:open-data-dir', () => shell.openPath(store.userDir()));
ipcMain.handle('system:open-sound-panel', () => shell.openPath('C:\\Windows\\System32\\mmsys.cpl'));
ipcMain.handle('system:open-external', (_e, url) => {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
});
ipcMain.handle('system:set-hotkeys', (_e, hotkeys) =>
  registerHotkeys(Object.assign({}, store.getSettings(), hotkeys)));

ipcMain.handle('window:minimize', () => win && win.minimize());
ipcMain.handle('window:hide', () => win && win.hide());
ipcMain.handle('window:close', () => win && win.close());
ipcMain.handle('window:set-active', (_e, active) => {
  translationActive = Boolean(active);
  refreshTrayMenu();
});

// ------------------------------------------------------------------ export --

function renderTranscript(session, ext) {
  if (ext === 'json') return JSON.stringify(session, null, 2);

  const when = (ts) => new Date(ts).toLocaleTimeString();
  const lines = session.lines || [];

  if (ext === 'md') {
    const head = [
      '# VoiceB transcript',
      '',
      `- **Started:** ${new Date(session.startedAt).toLocaleString()}`,
      `- **Duration:** ${formatDuration(session.durationMs)}`,
      `- **Languages:** ${session.myLanguage} / ${session.theirLanguage}`,
      `- **Estimated cost:** $${(session.estimatedCostUsd || 0).toFixed(3)}`,
      '',
    ].join('\n');
    const body = lines.map((l) => {
      const who = l.direction === 'outbound' ? 'You' : 'Them';
      const src = l.source ? `\n  > ${l.source}` : '';
      return `**${when(l.at)} - ${who}** ${l.translated || '...'}${src}`;
    }).join('\n\n');
    return head + body + '\n';
  }

  const head = [
    'VoiceB transcript',
    `Started:   ${new Date(session.startedAt).toLocaleString()}`,
    `Duration:  ${formatDuration(session.durationMs)}`,
    `Languages: ${session.myLanguage} <-> ${session.theirLanguage}`,
    '',
  ].join('\n');
  const body = lines.map((l) => {
    const who = l.direction === 'outbound' ? 'YOU ' : 'THEM';
    const src = l.source ? `\n            (${l.source})` : '';
    return `[${when(l.at)}] ${who}  ${l.translated || '...'}${src}`;
  }).join('\n');
  return head + body + '\n';
}

function formatDuration(ms) {
  const total = Math.round((ms || 0) / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

// ------------------------------------------------------------------ cables --

/**
 * Reports which VB-Audio virtual cables look installed. The setup panel uses
 * this: the outbound lane needs one cable, the inbound lane a second one.
 */
function detectCables() {
  // Every VB-Audio driver drops a folder under Program Files\VB, but the exact
  // names vary between products and versions. Enumerate rather than guess, and
  // only prettify the ones we recognise.
  const roots = [
    path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'VB'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'VB'),
  ];

  const pretty = {
    CABLE: 'VB-CABLE',
    CABLE_A: 'VB-CABLE A',
    CABLE_B: 'VB-CABLE B',
    CABLE_C: 'VB-CABLE C',
    CABLE_D: 'VB-CABLE D',
    CABLEHIFI: 'VB-Audio Hi-Fi Cable',
    HIFICABLE: 'VB-Audio Hi-Fi Cable',
    VOICEMEETER: 'VoiceMeeter',
  };

  const installed = [];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // root absent — nothing from this vendor installed here
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const key = entry.name.toUpperCase();
      installed.push({
        id: key.toLowerCase(),
        name: pretty[key] || entry.name,
        dir: path.join(root, entry.name),
      });
    }
  }

  return { downloadUrl: 'https://vb-audio.com/Cable/', installed };
}
