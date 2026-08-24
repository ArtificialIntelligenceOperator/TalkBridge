'use strict';

/**
 * Persistence for VoiceB.
 *
 * settings.json  — plain JSON, safe to inspect and hand-edit
 * apikey.bin     — OS-encrypted via Electron safeStorage (DPAPI on Windows)
 * history/*.json — one file per translation session
 *
 * Everything lives under app.getPath('userData').
 */

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const DEFAULTS = {
  // Which translator does the work.
  //   cloud — gpt-realtime-translate: continuous, interruptible, billed per minute
  //   local — Whisper + OPUS-MT + Piper on this machine: free and private,
  //           but it waits for a pause before it can translate
  engine: 'cloud',

  // local engine
  localAsr: 'auto',             // auto | gigaam | parakeet | whisper
  localWhisper: 'small',        // tiny | base | small | medium | large-v3-turbo
  localSpeculate: true,         // start recognising before the pause is certain
  localVoices: {},              // { en: 'en_US-ryan-medium', ru: ... } — Piper voice per language
  localTranslator: 'nllb',      // nllb (one model, 200 languages) | opus (one per pair)
  localDevice: 'cpu',           // cpu | cuda
  localThreads: 0,              // 0 = split the machine between the two lanes
  localSensitivity: 0.5,        // how far above the noise floor speech must sit
  localEndpointMs: 480,         // silence that ends an utterance
  localMaxUtteranceMs: 6000,    // cut a monologue here even without a pause
  localPartials: true,          // live captions before the final translation

  // language
  myLanguage: 'ru',        // what I speak
  theirLanguage: 'en',     // what they speak

  // Devices (empty = ask the user on first run).
  //
  // Each one is stored as an id *and* a label. Chromium device ids are not
  // durable — they change when a device is re-enumerated, and a Bluetooth
  // headset switching profile or a webcam whose mic is busy simply vanishes
  // from the list for a while. The label is what survives, so it is the key we
  // match on when the id no longer resolves.
  micDeviceId: '',         // my microphone
  micLabel: '',
  toCallDeviceId: '',      // virtual cable the meeting app listens to
  toCallLabel: '',
  fromCallDeviceId: '',    // virtual cable the meeting app plays into
  fromCallLabel: '',
  headphonesDeviceId: '',  // where I hear the translated remote voice
  headphonesLabel: '',

  // lanes
  outboundEnabled: true,   // me -> them
  inboundEnabled: true,    // them -> me

  // audio behaviour
  passthroughVolume: 0,    // original remote voice mixed under the translation
  outputVolume: 1.0,
  noiseReduction: 'near_field', // near_field | far_field | off
  transcription: true,     // stream source-language transcript too
  echoGate: false,         // mute inbound while outbound is speaking (speakerphone loops)

  // input control
  micMode: 'open',         // open | ptt
  hotkeyToggleMute: 'Control+Alt+Space',
  hotkeyShowWindow: 'Control+Alt+V',

  // misc
  minimizeToTray: true,
  autoSaveHistory: true,
  glossary: [],            // [{ from, to }] applied to transcripts only
  windowBounds: null,
};

let cachedSettings = null;

function userDir() {
  return app.getPath('userData');
}

function settingsFile() {
  return path.join(userDir(), 'settings.json');
}

function keyFile() {
  return path.join(userDir(), 'apikey.bin');
}

function historyDir() {
  return path.join(userDir(), 'history');
}

function readJson(file, fallback) {
  try {
    // Strip a UTF-8 BOM. Anything that edits these files from PowerShell writes
    // one by default, and JSON.parse rejects it — which would silently reset
    // every setting to its default instead of reporting a problem.
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    if (err instanceof SyntaxError) {
      console.error(`[store] ${file} is not valid JSON, falling back to defaults:`, err.message);
    }
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- settings --

function getSettings() {
  if (!cachedSettings) {
    cachedSettings = { ...DEFAULTS, ...readJson(settingsFile(), {}) };
  }
  return { ...cachedSettings };
}

function setSettings(patch) {
  cachedSettings = { ...getSettings(), ...patch };
  writeJson(settingsFile(), cachedSettings);
  return { ...cachedSettings };
}

// ----------------------------------------------------------------- api key --

function hasApiKey() {
  return fs.existsSync(keyFile());
}

function setApiKey(key) {
  if (!key) {
    try {
      fs.unlinkSync(keyFile());
    } catch { /* already gone */ }
    return;
  }
  fs.mkdirSync(userDir(), { recursive: true });
  if (safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(keyFile(), safeStorage.encryptString(key));
  } else {
    // No OS keyring (rare on Windows). Store obfuscated and mark it plainly so
    // the caller can warn the user rather than silently pretending it is safe.
    fs.writeFileSync(keyFile(), Buffer.concat([Buffer.from('PLAIN:'), Buffer.from(key, 'utf8')]));
  }
}

function getApiKey() {
  if (!hasApiKey()) return null;
  const raw = fs.readFileSync(keyFile());
  if (raw.subarray(0, 6).toString() === 'PLAIN:') return raw.subarray(6).toString('utf8');
  try {
    return safeStorage.decryptString(raw);
  } catch {
    return null;
  }
}

function encryptionAvailable() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------- history --

function listHistory() {
  const dir = historyDir();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const s = readJson(path.join(dir, f), null);
      if (!s) return null;
      return {
        id: s.id,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        durationMs: s.durationMs,
        myLanguage: s.myLanguage,
        theirLanguage: s.theirLanguage,
        lineCount: (s.lines || []).length,
        estimatedCostUsd: s.estimatedCostUsd,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

function readSession(id) {
  return readJson(path.join(historyDir(), `${sanitizeId(id)}.json`), null);
}

function saveSession(session) {
  if (!session || !session.id) throw new Error('session.id is required');
  writeJson(path.join(historyDir(), `${sanitizeId(session.id)}.json`), session);
  return session.id;
}

function deleteSession(id) {
  try {
    fs.unlinkSync(path.join(historyDir(), `${sanitizeId(id)}.json`));
    return true;
  } catch {
    return false;
  }
}

function sanitizeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '');
}

module.exports = {
  DEFAULTS,
  userDir,
  historyDir,
  getSettings,
  setSettings,
  hasApiKey,
  setApiKey,
  getApiKey,
  encryptionAvailable,
  listHistory,
  readSession,
  saveSession,
  deleteSession,
};
