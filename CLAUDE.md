# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # also generates assets/*.png|ico via the postinstall hook
npm start            # run the app
npm run dev          # same, with DevTools and renderer console mirrored to the terminal
npm run dist         # electron-builder --win nsis
npm run icon         # regenerate assets from scripts/make-icon.js
```

Never launch with `electron .`. VS Code, Cursor and agent tooling export
`ELECTRON_RUN_AS_NODE=1`; inherited into the launch it makes `electron.exe` behave
like plain Node and crash with `Cannot read properties of undefined`.
`scripts/start.js` strips the variable, and `VoiceB.cmd` / `VoiceB.vbs` do the same
for desktop launches — that is the only reason those launchers exist.

### Testing

There is no test suite and no linter. The only automated check is the local
engine's end-to-end smoke test, which synthesises a phrase, feeds it through the
whole pipeline and asserts that a transcript and audio come back:

```bash
.venv-local/Scripts/python src/local/server.py --selftest --source ru --target en
.venv-local/Scripts/python src/local/server.py --probe        # what is installed
.venv-local/Scripts/python src/local/server.py --port 0       # run the sidecar standalone
```

It needs the venv and models, which the app's Setup panel installs. Cloud-engine
changes can only be verified by running the app against a real API key.

## Architecture

A Windows-only Electron app that translates a live video call in both directions
at once. Two independent, symmetric **lanes** carry the work:

- **outbound** — my microphone → translated into their language → a virtual cable
  the meeting app uses as its microphone.
- **inbound** — a second virtual cable the meeting app plays into → translated
  into my language → my headphones.

The two directions must use two *different* virtual cable drivers, or the inbound
lane captures the outbound lane's own output and translates itself. The app
detects this and warns.

### Two engines behind one lane interface

`TranslationLane` ([lane.js](src/renderer/js/lane.js)) and `LocalLane`
([locallane.js](src/renderer/js/locallane.js)) expose the *same* surface —
`start/stop/setMuted/setOutputVolume/setOutputDevice`, the states
`connecting|live|failed|stopped`, and the events `state, line, lag, error,
capture, speaking, playback, playback-error, loading, audio-flowing, mute`.
[app.js](src/renderer/js/app.js) picks one by `settings.engine` and is otherwise
engine-agnostic. **Keep the two in parity** — anything added to one is usually
needed in the other.

They differ fundamentally, not merely in speed:

- **Cloud** — `gpt-realtime-translate` over WebRTC, one peer connection per lane.
  A single speech-to-speech model that listens and speaks at the same time, so it
  can be interrupted. ~0.3 s, billed per minute of audio per direction.
- **Local** — a Python sidecar pipeline `VAD → ASR → MT → TTS`. It cannot start
  translating a sentence it has not finished hearing, so it waits for a pause and
  is turn-based. Free and offline. This is a structural difference, not a setting.

The cloud model auto-detects the source language; the local engine must be told
both ends of the pair, because ASR is much more accurate when told and OPUS-MT is
one model per direction.

### The API key never reaches the renderer

[preload.js](src/main/preload.js) is a deliberately narrow bridge. The key is
encrypted with Electron `safeStorage` (DPAPI) in `%APPDATA%\VoiceB\apikey.bin` and
read only in the main process. The renderer can ask for a short-lived client
secret (`session:secret`) and have SDP proxied (`session:sdp`, which also sidesteps
CORS), but can never read the key. Preserve this when touching
[openai.js](src/main/openai.js) or the IPC surface.

### Local engine sidecar

[local.js](src/main/local.js) owns the Python process: it builds the venv, installs
packages, downloads models, spawns `server.py --port 0`, learns the bound port from
stdout, and restarts it if it dies. The renderer only ever learns a port number and
connects to `ws://127.0.0.1:<port>/`.

Protocol ([server.py](src/local/server.py) header documents it): binary frames are
Int16 LE mono PCM at 16 kHz; text frames are JSON — client sends
`hello|mute|flush|preload|say|ping`, server replies
`ready|partial|final|audio|speaking|lag|error`. Synthesised audio comes back
base64-encoded inside JSON rather than as binary frames, deliberately: one ordered
stream of self-describing messages removes a class of "which header did this buffer
belong to" bugs, and on loopback the overhead is immeasurable.

Each WebSocket connection builds its **own** engine on its **own** thread — its own
ASR, translator and voice. That doubles RAM and is the entire point: neither
direction ever queues behind the other. Model *weights* are shared across lanes
where the model allows it (ASR takes the language as a call argument, NLLB is
multilingual by design), and the cache lives in the sidecar process, so models
survive Stop and a second Start costs milliseconds rather than ~21 s.

### Audio output goes through AudioContext, not setSinkId

`<audio>.setSinkId` is unreliable for **remote WebRTC streams** in Chromium: the
promise resolves, `sinkId` reads back correctly, and the audio still goes to the
default device — visible only in Windows' audio session counter, never in the logs.
Every lane therefore plays through an `AudioContext` constructed with its device:

```js
this.ctx = new AudioContext({ sinkId: outputDeviceId });
```

That either binds or throws — there is no silent-wrong-device state. The muted
`<audio>` element alongside it is **required**: without it Chromium will not feed
the remote stream into Web Audio at all. Do not "clean it up".

Device *ids* are not durable in Chromium — they change on re-enumeration, and a
Bluetooth headset switching profile vanishes entirely. Every device is therefore
stored as an id *and* a label, and the label is what re-matches when the id no
longer resolves.

### Settings

[store.js](src/main/store.js) holds a `DEFAULTS` object merged over the on-disk
`settings.json`, so a new setting only needs a key there — no migration step.
Settings files are read BOM-tolerantly because anything editing them from
PowerShell writes one, and `JSON.parse` would otherwise silently reset everything
to defaults.

Language and noise-reduction changes only take effect at the next Start: both are
fixed when the session is created.

## Conventions

Comments in this codebase explain **why**, usually recording a specific failure that
was diagnosed the hard way (the `setSinkId` lie, `ELECTRON_RUN_AS_NODE`, VAD before
a transducer ASR, the BOM). Match that register: when a workaround looks arbitrary,
say what breaks without it. The README documents measured latency numbers — if you
change the pipeline, re-measure rather than adjusting the prose.

User-facing strings in the renderer are English; the README is Russian.
