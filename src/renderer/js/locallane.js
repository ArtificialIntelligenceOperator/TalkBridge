/**
 * LocalLane — one direction of interpretation, translated on this machine.
 *
 * Deliberately interface-compatible with TranslationLane: same constructor
 * options, same events, same controls. app.js picks between them by engine and
 * otherwise cannot tell which one it is holding.
 *
 * What differs is underneath. The cloud lane is a WebRTC peer connection to a
 * model that listens and speaks at the same time, so either side can cut in
 * mid-sentence. This one is a pipeline of separate models — detect speech,
 * transcribe it, translate it, synthesise it — and a pipeline cannot start
 * translating a sentence it has not heard the end of. So it waits for a pause,
 * then works. Expect roughly a second and a half behind the speaker instead of
 * a quarter of one, in exchange for costing nothing and leaving no audio.
 *
 * Audio flows:
 *   capture device -> AudioContext @16kHz -> worklet -> Int16 -> WebSocket
 *   WebSocket -> Int16 -> AudioBuffer -> AudioContext pinned to the output
 */
(function (VB) {
  'use strict';

  const WORKLET_URL = 'js/capture-worklet.js';
  const CAPTURE_RATE = 16000;
  // Loading Whisper, NLLB and a voice from a cold cache takes about fifteen
  // seconds, and longer on a slow disk. The timeout has to clear that with
  // room to spare or a first start on a busy machine fails for no good reason.
  const CONNECT_TIMEOUT_MS = 90000;

  // How far ahead of the clock synthesised speech is scheduled. Enough to
  // absorb a slow chunk, short enough that nobody hears it as delay.
  const SCHEDULE_LEAD_S = 0.06;

  class LocalLane {
    constructor(options) {
      this.name = options.name;
      this.label = options.label || options.name;
      this.inputDeviceId = options.inputDeviceId || '';
      this.inputLabel = options.inputLabel || '';
      this.outputDeviceId = options.outputDeviceId || '';
      this.outputLabel = options.outputLabel || '';
      this.sourceLanguage = options.sourceLanguage;
      this.targetLanguage = options.targetLanguage;
      this.audioProcessing = options.audioProcessing !== false;
      this.outputVolume = options.outputVolume == null ? 1 : options.outputVolume;
      this.startMuted = Boolean(options.startMuted);
      this.engineOptions = options.engineOptions || {};

      this.state = 'idle';
      this.stream = null;
      this.track = null;
      this.ws = null;
      this.captureCtx = null;
      this.captureNode = null;
      this.captureSource = null;
      this.captureSink = null;
      this.playCtx = null;
      this.gain = null;
      this.playRate = 22050;
      this.nextPlayAt = 0;
      this.info = null;

      this._handlers = new Map();
      this._lines = new Map();
      this._muted = this.startMuted;
      this._stopped = false;
      this._sentAudio = false;
    }

    // ------------------------------------------------------------- events --

    on(event, handler) {
      if (!this._handlers.has(event)) this._handlers.set(event, new Set());
      this._handlers.get(event).add(handler);
      return () => this._handlers.get(event).delete(handler);
    }

    _emit(event, payload) {
      const set = this._handlers.get(event);
      if (!set) return;
      for (const handler of set) {
        try {
          handler(payload);
        } catch (err) {
          console.error(`[${this.name}] handler for ${event} threw`, err);
        }
      }
    }

    _setState(state, detail) {
      if (this.state === state) return;
      this.state = state;
      this._emit('state', { state, detail });
    }

    // ---------------------------------------------------------- lifecycle --

    async start() {
      this._stopped = false;
      this._setState('connecting');
      try {
        const { port } = await window.voiceb.local.start();
        await this._openCapture();
        await this._openPlayback();
        await this._connect(port);
      } catch (err) {
        await this._teardown();
        this._setState('failed', err.message);
        throw err;
      }
    }

    async _openCapture() {
      const audio = { channelCount: 1 };
      if (this.inputDeviceId) audio.deviceId = { exact: this.inputDeviceId };
      audio.echoCancellation = this.audioProcessing;
      audio.noiseSuppression = this.audioProcessing;
      audio.autoGainControl = this.audioProcessing;

      this.stream = await VB.openCapture(audio, this.label, this.inputLabel);
      this.track = this.stream.getAudioTracks()[0];
      if (!this.track) throw new Error('Capture device produced no audio track');
      this.track.addEventListener('ended', () => {
        if (!this._stopped) this._setState('failed', 'Input device disconnected');
      });

      // Whisper wants 16 kHz mono. Asking the context for that rate makes
      // Chromium resample the device for us, on the audio thread, instead of
      // us doing it badly in JavaScript.
      this.captureCtx = new AudioContext({ sampleRate: CAPTURE_RATE });
      await this.captureCtx.audioWorklet.addModule(WORKLET_URL);
      this.captureSource = this.captureCtx.createMediaStreamSource(this.stream);
      this.captureNode = new AudioWorkletNode(this.captureCtx, 'voiceb-capture');
      this.captureNode.port.onmessage = (event) => this._sendPcm(event.data);
      this.captureNode.port.postMessage({ type: 'mute', on: this._muted });
      // Web Audio is pull-based: a node with no path to the destination is
      // never asked to process anything, so an unconnected worklet silently
      // captures nothing at all. Route it through a muted gain instead — the
      // graph pulls it, and not a sample reaches the speakers.
      this.captureSink = this.captureCtx.createGain();
      this.captureSink.gain.value = 0;
      this.captureSource.connect(this.captureNode);
      this.captureNode.connect(this.captureSink).connect(this.captureCtx.destination);

      this._emit('capture', { stream: this.stream });
    }

    async _openPlayback() {
      try {
        this.playCtx = new AudioContext(
          this.outputDeviceId ? { sinkId: this.outputDeviceId } : {});
        this.gain = this.playCtx.createGain();
        this.gain.gain.value = this.outputVolume;
        this.gain.connect(this.playCtx.destination);
        if (this.playCtx.state === 'suspended') await this.playCtx.resume();
      } catch (err) {
        this._emit('playback-error', new Error(
          `cannot route audio to “${this.outputLabel || 'the selected device'}” `
          + `(${err.name}: ${err.message}).`));
      }
      console.info(`[${this.name}] local playback ` + JSON.stringify({
        sink: this.playCtx ? (this.playCtx.sinkId || 'default') : 'none',
        state: this.playCtx ? this.playCtx.state : 'none',
        requested: this.outputDeviceId,
        label: this.outputLabel,
      }));
    }

    _connect(port) {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
        ws.binaryType = 'arraybuffer';
        this.ws = ws;

        const timer = setTimeout(() => {
          reject(new Error('the local engine did not answer in time'));
          try { ws.close(); } catch { /* already closing */ }
        }, CONNECT_TIMEOUT_MS);

        let ready = false;

        ws.addEventListener('open', () => {
          ws.send(JSON.stringify({
            type: 'hello',
            name: this.name,
            source: this.sourceLanguage,
            target: this.targetLanguage,
            ...this.engineOptions,
          }));
        });

        ws.addEventListener('message', (event) => {
          let message;
          try {
            message = JSON.parse(event.data);
          } catch {
            return;
          }
          if (message.type === 'ready') {
            ready = true;
            clearTimeout(timer);
            this.info = message.info;
            this.playRate = message.info.sampleRate || this.playRate;
            console.info(`[${this.name}] engine ready ` + JSON.stringify(message.info));
            this._setState('live');
            resolve();
            return;
          }
          if (message.type === 'loading' && !ready) {
            this._emit('loading', { stage: message.stage });
            return;
          }
          if (message.type === 'error' && !ready) {
            clearTimeout(timer);
            reject(new Error(message.message));
            return;
          }
          this._onMessage(message);
        });

        ws.addEventListener('error', () => {
          if (!ready) {
            clearTimeout(timer);
            reject(new Error('could not reach the local engine'));
          }
        });

        ws.addEventListener('close', () => {
          if (this._stopped) return;
          if (!ready) {
            clearTimeout(timer);
            reject(new Error('the local engine closed the connection'));
            return;
          }
          this._setState('failed', 'the local engine stopped');
        });
      });
    }

    async stop() {
      this._stopped = true;
      await this._teardown();
      this._setState('stopped');
    }

    async _teardown() {
      if (this.ws) {
        try { this.ws.close(); } catch { /* already closed */ }
        this.ws = null;
      }
      if (this.captureNode) {
        this.captureNode.port.onmessage = null;
        try { this.captureNode.disconnect(); } catch { /* already gone */ }
        this.captureNode = null;
      }
      if (this.captureSource) {
        try { this.captureSource.disconnect(); } catch { /* already gone */ }
        this.captureSource = null;
      }
      if (this.captureSink) {
        try { this.captureSink.disconnect(); } catch { /* already gone */ }
        this.captureSink = null;
      }
      if (this.captureCtx) {
        try { await this.captureCtx.close(); } catch { /* already closed */ }
        this.captureCtx = null;
      }
      if (this.gain) {
        try { this.gain.disconnect(); } catch { /* already gone */ }
        this.gain = null;
      }
      if (this.playCtx) {
        try { await this.playCtx.close(); } catch { /* already closed */ }
        this.playCtx = null;
      }
      if (this.stream) {
        for (const track of this.stream.getTracks()) track.stop();
        this.stream = null;
      }
      this.track = null;
      this._lines.clear();
      this.nextPlayAt = 0;
    }

    // ----------------------------------------------------------- controls --

    setMuted(muted) {
      this._muted = Boolean(muted);
      // Gate in the worklet *and* in the engine. The worklet stops the audio
      // at the source; the engine message also throws away a half-heard
      // utterance, so unmuting does not replay the tail of one.
      if (this.captureNode) {
        this.captureNode.port.postMessage({ type: 'mute', on: this._muted });
      }
      this._send({ type: 'mute', on: this._muted });
      this._emit('mute', { muted: this._muted });
    }

    get isMuted() {
      return this._muted;
    }

    setOutputVolume(volume) {
      this.outputVolume = volume;
      if (this.gain) this.gain.gain.value = volume;
    }

    async setOutputDevice(deviceId) {
      this.outputDeviceId = deviceId || '';
      if (this.playCtx && typeof this.playCtx.setSinkId === 'function') {
        await this.playCtx.setSinkId(this.outputDeviceId);
      }
    }

    // -------------------------------------------------------------- audio --

    _sendPcm(pcm) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this._muted) return;
      // Never let the socket become the buffer. If the engine stalls, dropping
      // frames keeps us near real time; queueing them means every later
      // sentence arrives late too.
      if (this.ws.bufferedAmount > 1 << 20) return;
      this.ws.send(pcm.buffer);
      this._sentAudio = true;
    }

    _send(message) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(message));
      }
    }

    _onMessage(message) {
      switch (message.type) {
        case 'partial':
          return this._line(message.id, message.source, '', false);
        case 'final':
          return this._line(message.id, message.source, message.translated, true);
        case 'audio':
          return this._play(message);
        case 'loading':
          return this._emit('loading', { stage: message.stage });
        case 'speaking':
          return this._emit('speaking', { speaking: Boolean(message.on) });
        case 'lag':
          console.info(`[${this.name}] ${message.ms} ms behind `
            + `(${message.utteranceMs} ms of speech)`);
          return this._emit('lag', { ms: message.ms });
        case 'error':
          return this._emit('error', new Error(message.message));
        default:
          return undefined;
      }
    }

    _line(id, source, translated, done) {
      const key = `${this.name}-${id}`;
      let entry = this._lines.get(key);
      if (!entry) {
        entry = { id: key, at: Date.now() };
        this._lines.set(key, entry);
      }
      this._emit('line', {
        id: entry.id,
        direction: this.name,
        at: entry.at,
        source,
        translated,
        done,
      });
      if (done) this._lines.delete(key);
    }

    _play(message) {
      if (!this.playCtx || !this.gain) return;
      const rate = message.rate || this.playRate;
      const bytes = atob(message.pcm);
      const samples = bytes.length >> 1;
      if (!samples) return;

      const buffer = this.playCtx.createBuffer(1, samples, rate);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < samples; i += 1) {
        const lo = bytes.charCodeAt(i * 2);
        const hi = bytes.charCodeAt(i * 2 + 1);
        const value = (hi << 8) | lo;
        channel[i] = (value >= 0x8000 ? value - 0x10000 : value) / 32768;
      }

      // Butt each chunk against the previous one so a sentence split across
      // several messages plays as continuous speech rather than as words with
      // gaps between them.
      const now = this.playCtx.currentTime;
      const at = Math.max(now + SCHEDULE_LEAD_S, this.nextPlayAt);
      const source = this.playCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.gain);
      source.start(at);
      this.nextPlayAt = at + buffer.duration;
      this._emit('audio-flowing', { flowing: true });
    }
  }

  /**
   * Loads the models before anybody presses Start.
   *
   * The engine keeps what it loads, shared across both directions and across
   * sessions, so doing this while the user is still reading the Setup panel
   * turns a fifteen-second "Connecting…" into an instant one. Best effort by
   * design: if it fails, Start simply pays the cost the old way.
   *
   * Returns a promise that settles when every lane has reported back.
   */
  async function preloadLocal(configs, onStage) {
    const { port } = await window.voiceb.local.start();
    return new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
      let pending = configs.length;
      const done = () => {
        try { ws.close(); } catch { /* already closing */ }
        resolve();
      };
      const timer = setTimeout(done, 5 * 60 * 1000);

      ws.addEventListener('open', () => {
        for (const cfg of configs) ws.send(JSON.stringify({ type: 'preload', ...cfg }));
      });
      ws.addEventListener('message', (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === 'loading' && onStage) onStage(message.stage);
        if (message.type === 'preloaded' || message.type === 'preload-failed') {
          pending -= 1;
          if (pending <= 0) { clearTimeout(timer); done(); }
        }
      });
      ws.addEventListener('error', () => { clearTimeout(timer); done(); });
      ws.addEventListener('close', () => { clearTimeout(timer); resolve(); });
    });
  }

  /**
   * Asks the engine to speak `text` in `voice` and resolves with the PCM —
   * the voice preview in Setup. Fetches the voice first if it is not on disk,
   * which is why the timeout is generous.
   */
  async function sayLocal(voice, text) {
    const { port } = await window.voiceb.local.start();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
      const timer = setTimeout(() => {
        try { ws.close(); } catch { /* already closing */ }
        reject(new Error('the engine did not answer'));
      }, 120000);
      const finish = (fn, value) => {
        clearTimeout(timer);
        try { ws.close(); } catch { /* already closing */ }
        fn(value);
      };
      ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'say', voice, text })));
      ws.addEventListener('message', (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === 'said' && message.voice === voice) {
          finish(resolve, { pcm: decodePcm(message.pcm), rate: message.rate });
        } else if (message.type === 'say-failed') {
          finish(reject, new Error(message.message));
        }
      });
      ws.addEventListener('error', () => finish(reject, new Error('could not reach the local engine')));
    });
  }

  function decodePcm(b64) {
    const bytes = atob(b64);
    const out = new Float32Array(bytes.length >> 1);
    for (let i = 0; i < out.length; i += 1) {
      const value = (bytes.charCodeAt(i * 2 + 1) << 8) | bytes.charCodeAt(i * 2);
      out[i] = (value >= 0x8000 ? value - 0x10000 : value) / 32768;
    }
    return out;
  }

  /** Plays float PCM once on a given output device. */
  async function playPcm(pcm, rate, sinkId) {
    const ctx = new AudioContext(sinkId ? { sinkId } : {});
    const buffer = ctx.createBuffer(1, pcm.length, rate);
    buffer.getChannelData(0).set(pcm);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    if (ctx.state === 'suspended') await ctx.resume();
    source.start();
    await new Promise((resolve) => { source.onended = resolve; });
    await ctx.close();
  }

  VB.LocalLane = LocalLane;
  VB.preloadLocal = preloadLocal;
  VB.sayLocal = sayLocal;
  VB.playPcm = playPcm;
})(window.VB = window.VB || {});
