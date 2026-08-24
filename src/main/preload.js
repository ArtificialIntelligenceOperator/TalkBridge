'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only bridge between the renderer and Node. Deliberately narrow: the
 * renderer can ask for a short-lived client secret but can never read the
 * API key itself.
 */

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('voiceb', {
  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
  },

  key: {
    status: () => invoke('key:status'),
    set: (value) => invoke('key:set', value),
    clear: () => invoke('key:set', ''),
    verify: () => invoke('key:verify'),
  },

  session: {
    // options: { language, sourceHint, transcription, noiseReduction }
    secret: (options) => invoke('session:secret', options),
    sdp: (clientSecret, offerSdp) => invoke('session:sdp', { clientSecret, offerSdp }),
    pricePerMinuteUsd: () => invoke('session:price'),
  },

  /** The offline engine: model management and the sidecar's lifetime. */
  local: {
    probe: () => invoke('local:probe'),
    probeGpu: () => invoke('local:probe-gpu'),
    setup: (options) => invoke('local:setup', options),
    download: (options) => invoke('local:download', options),
    start: () => invoke('local:start'),
    stop: () => invoke('local:stop'),
    status: () => invoke('local:status'),
  },

  history: {
    list: () => invoke('history:list'),
    read: (id) => invoke('history:read', id),
    save: (session) => invoke('history:save', session),
    remove: (id) => invoke('history:delete', id),
    exportTo: (id, format) => invoke('history:export', { id, format }),
  },

  system: {
    info: () => invoke('system:info'),
    cables: () => invoke('system:cables'),
    openDataDir: () => invoke('system:open-data-dir'),
    openSoundPanel: () => invoke('system:open-sound-panel'),
    openExternal: (url) => invoke('system:open-external', url),
    setHotkeys: (hotkeys) => invoke('system:set-hotkeys', hotkeys),
  },

  window: {
    minimize: () => invoke('window:minimize'),
    hide: () => invoke('window:hide'),
    close: () => invoke('window:close'),
    setActive: (active) => invoke('window:set-active', active),
  },

  /** Main -> renderer pushes: 'hotkey:toggle-mute', 'tray:toggle-mute', 'app:before-quit'. */
  on: (channel, handler) => {
    const allowed = ['hotkey:toggle-mute', 'tray:toggle-mute', 'tray:stop',
                     'app:before-quit', 'local:progress'];
    if (!allowed.includes(channel)) return () => {};
    const wrapped = (_event, ...args) => handler(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
