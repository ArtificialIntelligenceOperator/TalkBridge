'use strict';

/**
 * Supervisor for the local translation engine.
 *
 * The engine is a Python process (src/local/server.py) speaking WebSocket on
 * loopback. This module owns its lifetime: it finds an interpreter, starts the
 * process on demand, learns the port it bound, restarts it if it dies, and
 * reports what models are installed so the Setup panel can offer to fetch the
 * missing ones.
 *
 * Everything here is main-process work. The renderer only ever learns a port
 * number and connects to it.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const ROOT = path.join(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'src', 'local', 'server.py');
const VENV = path.join(ROOT, '.venv-local');
const VENV_PYTHON = path.join(VENV, 'Scripts', 'python.exe');

const START_TIMEOUT_MS = 20000;
const PROBE_TIMEOUT_MS = 30000;

let child = null;
let port = 0;
let starting = null;
let onEvent = () => {};

function setEventSink(fn) {
  onEvent = typeof fn === 'function' ? fn : () => {};
}

// ------------------------------------------------------------- interpreter --

/**
 * Prefers the project venv. A system Python usually has none of the packages,
 * so falling back to it produces a confusing ImportError rather than a clear
 * "run setup" — which is why `available` is reported separately.
 */
function pythonPath() {
  if (fs.existsSync(VENV_PYTHON)) return VENV_PYTHON;
  return process.platform === 'win32' ? 'python' : 'python3';
}

function installed() {
  return fs.existsSync(VENV_PYTHON) && fs.existsSync(SERVER);
}

/**
 * CTranslate2 loads cuBLAS and cuDNN by name at runtime. Pip puts them inside
 * site-packages rather than anywhere Windows looks, so the directories have to
 * be on PATH or every CUDA start fails with "cublas64_12.dll is not found".
 */
function childEnv() {
  const env = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
    // Keep Hugging Face downloads with the rest of the models, off the system
    // drive. server.py sets the same default; this covers pip and any tool run
    // before server.py gets a say.
    HF_HOME: path.join(modelsDir(), 'hf'),
    HF_HUB_DISABLE_TELEMETRY: '1',
  };
  delete env.ELECTRON_RUN_AS_NODE;

  const site = path.join(VENV, 'Lib', 'site-packages', 'nvidia');
  const extra = [];
  if (fs.existsSync(site)) {
    for (const pkg of fs.readdirSync(site)) {
      const bin = path.join(site, pkg, 'bin');
      if (fs.existsSync(bin)) extra.push(bin);
    }
  }
  if (extra.length) env.PATH = `${extra.join(path.delimiter)}${path.delimiter}${env.PATH}`;
  return env;
}

/**
 * Finds a Python to build the venv with.
 *
 * Newest is not best here: CTranslate2, onnxruntime and sentencepiece all ship
 * wheels for the last two or three releases only, and pip building any of them
 * from source on Windows is not something to inflict on a user. So walk down
 * from a known-good version rather than taking whatever `python` happens to be.
 */
function findSystemPython() {
  const candidates = [];
  if (process.platform === 'win32') {
    for (const v of ['3.12', '3.11', '3.13', '3.10']) candidates.push(['py', [`-${v}`]]);
    const local = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Python');
    for (const v of ['Python312', 'Python311', 'Python313', 'Python310']) {
      candidates.push([path.join(local, v, 'python.exe'), []]);
    }
  }
  candidates.push(['python3', []], ['python', []]);

  const { spawnSync } = require('child_process');
  for (const [cmd, args] of candidates) {
    if (path.isAbsolute(cmd) && !fs.existsSync(cmd)) continue;
    const probeRun = spawnSync(cmd, [...args, '-c', 'import sys;print(sys.version_info[:2])'],
      { encoding: 'utf8', windowsHide: true });
    if (probeRun.status === 0) return { cmd, args, version: probeRun.stdout.trim() };
  }
  return null;
}

/** Creates the venv and installs the engine's packages. Minutes, not seconds. */
async function setup({ gpu = false } = {}) {
  const report = (line) => onEvent({ type: 'setup-progress', line });

  if (!fs.existsSync(VENV_PYTHON)) {
    const python = findSystemPython();
    if (!python) {
      throw new Error('No Python found. Install Python 3.12 from python.org, '
        + 'tick “Add python.exe to PATH”, then run setup again.');
    }
    report(`creating environment with ${python.cmd} ${python.version}`);
    await runTool(python.cmd, [...python.args, '-m', 'venv', VENV], report, 10 * 60 * 1000);
  }

  report('installing packages (about 1.2 GB, this takes a few minutes)');
  await runTool(VENV_PYTHON, ['-m', 'pip', 'install', '--upgrade', 'pip'], report,
    10 * 60 * 1000);
  await runTool(VENV_PYTHON,
    ['-m', 'pip', 'install', '-r', path.join(ROOT, 'src', 'local', 'requirements.txt')],
    report, 30 * 60 * 1000);

  if (gpu) {
    report('installing CUDA libraries (about 700 MB)');
    await runTool(VENV_PYTHON,
      ['-m', 'pip', 'install', 'nvidia-cublas-cu12', 'nvidia-cudnn-cu12'],
      report, 30 * 60 * 1000);
  }

  report('done');
  return probe();
}

function runTool(cmd, args, report, timeout) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { env: childEnv(), windowsHide: true, cwd: ROOT });
    let tail = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`${path.basename(cmd)} timed out`));
    }, timeout);

    const scan = (buf) => {
      const text = buf.toString();
      tail = (tail + text).slice(-4000);
      for (const line of text.split(/\r?\n/)) {
        // pip narrates every wheel it touches; only the milestones are useful.
        if (/^\s*(Collecting|Installing collected|Successfully|Downloading|ERROR)/.test(line)) {
          report(line.trim());
        }
      }
    };
    proc.stdout.on('data', scan);
    proc.stderr.on('data', scan);

    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const last = tail.trim().split(/\r?\n/).filter(Boolean).pop() || `exit ${code}`;
      reject(new Error(last));
    });
  });
}

function modelsDir() {
  // Keep models beside the app when it is a checkout, and in userData when it
  // is packaged and the install directory is read-only.
  if (!app.isPackaged) return path.join(ROOT, 'models');
  return path.join(app.getPath('userData'), 'models');
}

// ------------------------------------------------------------- one-shot run --

function run(args, { timeout = PROBE_TIMEOUT_MS, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonPath(), [SERVER, ...args], {
      env: { ...childEnv(), VOICEB_MODELS: modelsDir() },
      windowsHide: true,
    });

    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`local engine timed out after ${Math.round(timeout / 1000)}s`));
    }, timeout);

    proc.stdout.on('data', (buf) => { out += buf.toString(); });
    proc.stderr.on('data', (buf) => {
      const text = buf.toString();
      err += text;
      if (onLine) {
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) onLine(line.replace(/^\[local\]\s*/, ''));
        }
      }
    });

    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`cannot run Python (${pythonPath()}): ${e.message}`));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ out, err });
      // The last stderr line is almost always the actual cause; the traceback
      // above it is noise to anyone who is not editing server.py.
      const lastLine = err.trim().split(/\r?\n/).pop() || `exit code ${code}`;
      reject(new Error(lastLine));
    });
  });
}

// ------------------------------------------------------------------- probe --

async function probe() {
  if (!installed()) {
    return {
      ready: false,
      installed: false,
      reason: 'The local engine is not set up yet.',
      python: pythonPath(),
      models: modelsDir(),
      whisper: [], voices: [], pairs: [],
    };
  }
  try {
    const { out } = await run(['--probe']);
    const info = JSON.parse(out.trim().split(/\r?\n/).pop());
    return {
      ...info,
      installed: true,
      ready: !info.missingPackages.length && info.whisper.length > 0
             && info.voices.length > 0,
    };
  } catch (err) {
    return {
      ready: false, installed: true, reason: err.message,
      python: pythonPath(), models: modelsDir(),
      whisper: [], voices: [], pairs: [],
    };
  }
}

/** Reports whether the machine can run Whisper on the GPU. */
async function probeGpu() {
  try {
    const { out } = await run(['--probe-gpu'], { timeout: 60000 });
    return JSON.parse(out.trim().split(/\r?\n/).pop());
  } catch (err) {
    return { cuda: false, reason: err.message };
  }
}

// ---------------------------------------------------------------- download --

async function download({ whisper = 'small', langs = ['en', 'ru'],
                          translator = 'nllb', asr = 'auto', voices = [] } = {}) {
  await run(['--download', '--whisper', whisper, '--langs', langs.join(','),
             '--translator', translator, '--asr', asr,
             ...(voices.length ? ['--voices', voices.join(',')] : [])], {
    timeout: 60 * 60 * 1000,
    onLine: (line) => onEvent({ type: 'download-progress', line }),
  });
  return probe();
}

// ----------------------------------------------------------------- process --

/** Starts the engine if it is not already up and returns its port. */
function start() {
  if (child && port) return Promise.resolve({ port });
  if (starting) return starting;

  starting = new Promise((resolve, reject) => {
    const proc = spawn(pythonPath(), [SERVER, '--port', '0'], {
      env: { ...childEnv(), VOICEB_MODELS: modelsDir() },
      windowsHide: true,
    });
    child = proc;

    let stdout = '';
    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      starting = null;
      try { proc.kill(); } catch { /* already gone */ }
      reject(new Error(message));
    };

    const timer = setTimeout(
      () => fail('the local engine did not start in time'), START_TIMEOUT_MS);

    proc.stdout.on('data', (buf) => {
      stdout += buf.toString();
      const line = stdout.split(/\r?\n/).find((l) => l.includes('"listening"'));
      if (!line || settled) return;
      try {
        port = JSON.parse(line).port;
      } catch {
        return;
      }
      settled = true;
      clearTimeout(timer);
      starting = null;
      console.info(`[local] engine listening on 127.0.0.1:${port}`);
      resolve({ port });
    });

    proc.stderr.on('data', (buf) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        if (!line.trim()) continue;
        console.info(`[local] ${line}`);
        onEvent({ type: 'log', line: line.replace(/^\[local\]\s*/, '') });
      }
    });

    proc.on('error', (err) => fail(`cannot run Python (${pythonPath()}): ${err.message}`));
    proc.on('close', (code) => {
      const wasCurrent = child === proc;
      if (wasCurrent) { child = null; port = 0; }
      clearTimeout(timer);
      fail(`the local engine exited (code ${code}) before it was ready`);
      if (wasCurrent && code !== 0 && code !== null) {
        onEvent({ type: 'exited', code });
      }
    });
  });

  return starting;
}

function stop() {
  if (!child) return;
  const proc = child;
  child = null;
  port = 0;
  try { proc.kill(); } catch { /* already gone */ }
}

function status() {
  return { running: Boolean(child) && port > 0, port, python: pythonPath(),
           installed: installed(), models: modelsDir() };
}

app.on('will-quit', stop);

module.exports = {
  probe, probeGpu, setup, download, start, stop, status, setEventSink,
  pythonPath, modelsDir, installed, findSystemPython,
};
