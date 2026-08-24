/**
 * TranslationLane — one direction of simultaneous interpretation.
 *
 * A lane owns a capture device, a WebRTC peer connection to
 * gpt-realtime-translate, and a playback element pinned to an output device.
 * Audio streams in continuously and translated audio streams back
 * continuously; there is no turn taking, which is exactly what lets both
 * people talk over each other.
 *
 * Two lanes run at once:
 *   outbound — my microphone      -> translated into their language -> virtual cable
 *   inbound  — the call's audio   -> translated into my language    -> my headphones
 */
(function (VB) {
  'use strict';

  const ICE_GATHER_TIMEOUT_MS = 4000;
  const SEGMENT_GAP_MS = 4000;

  class TranslationLane {
    constructor(options) {
      this.name = options.name;                              // 'outbound' | 'inbound'
      this.label = options.label || options.name;
      this.inputDeviceId = options.inputDeviceId || '';
      this.inputLabel = options.inputLabel || '';
      this.outputDeviceId = options.outputDeviceId || '';
      this.outputLabel = options.outputLabel || '';
      this.targetLanguage = options.targetLanguage;
      this.transcription = options.transcription !== false;
      this.noiseReduction = options.noiseReduction || 'near_field';

      // Real microphones want AEC/NS/AGC. A virtual cable carries a clean
      // digital feed, and that processing only smears it.
      this.audioProcessing = options.audioProcessing !== false;

      this.outputVolume = options.outputVolume == null ? 1 : options.outputVolume;
      this.startMuted = Boolean(options.startMuted);

      this.state = 'idle';       // idle | connecting | live | failed | stopped
      this.stream = null;
      this.track = null;
      this.pc = null;
      this.dc = null;
      this.audioEl = null;
      this.remoteStream = null;
      this.ctx = null;
      this.gain = null;
      this.srcNode = null;

      this._handlers = new Map();
      this._segments = new Map();
      this._unknownEvents = new Set();
      this._segmentSeq = 0;
      this._lastSourceAt = 0;
      this._stopped = false;
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

    // -------------------------------------------------------- lifecycle --

    async start() {
      this._stopped = false;
      this._setState('connecting');

      try {
        await this._openCapture();
        const secret = await window.voiceb.session.secret({
          language: this.targetLanguage,
          transcription: this.transcription,
          noiseReduction: this.noiseReduction,
        });
        await this._connect(secret.value);
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

      this.stream = await openCapture(audio, this.label, this.inputLabel);
      this.track = this.stream.getAudioTracks()[0];
      if (!this.track) throw new Error('Capture device produced no audio track');
      this.track.enabled = !this.startMuted;

      // A device unplugged mid-call ends the track; surface it rather than
      // going quietly dead.
      this.track.addEventListener('ended', () => {
        if (!this._stopped) this._setState('failed', 'Input device disconnected');
      });

      this._emit('capture', { stream: this.stream });
    }

    async _connect(clientSecret) {
      const pc = new RTCPeerConnection();
      this.pc = pc;

      pc.addTrack(this.track, this.stream);

      this.dc = pc.createDataChannel('oai-events');
      this.dc.addEventListener('message', (event) => this._onServerEvent(event.data));

      pc.addEventListener('track', (event) => {
        this.remoteStream = event.streams[0] || new MediaStream([event.track]);
        this._attachPlayback().catch((err) => this._emit('error', err));
      });

      pc.addEventListener('connectionstatechange', () => {
        if (this._stopped) return;
        if (pc.connectionState === 'connected') this._setState('live');
        if (pc.connectionState === 'failed') this._setState('failed', 'WebRTC connection failed');
        if (pc.connectionState === 'disconnected') this._setState('failed', 'WebRTC disconnected');
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await waitForIceGathering(pc);

      const answerSdp = await window.voiceb.session.sdp(clientSecret, pc.localDescription.sdp);
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    }

    async _attachPlayback() {
      // Playback goes through an AudioContext pinned to the target device
      // rather than <audio>.setSinkId.
      //
      // For *remote* WebRTC streams Chromium renders through the audio service
      // and honours an element's sinkId only sometimes: setSinkId resolves, the
      // sinkId property reads back correctly, and the sound still comes out of
      // the default device. AudioContext takes the device at construction, so
      // there is nothing to race and nothing to silently ignore.
      //
      // The muted element below is not decoration: Chromium will not pump a
      // remote stream into Web Audio unless the stream is also attached to a
      // media element.
      const el = new Audio();
      el.autoplay = false;
      el.muted = true;
      el.setAttribute('data-lane', this.name);
      el.style.display = 'none';
      document.body.appendChild(el);
      this.audioEl = el;

      try {
        this.ctx = new AudioContext(
          this.outputDeviceId ? { sinkId: this.outputDeviceId } : {});
        this.gain = this.ctx.createGain();
        this.gain.gain.value = this.outputVolume;
        this.srcNode = this.ctx.createMediaStreamSource(this.remoteStream);
        this.srcNode.connect(this.gain).connect(this.ctx.destination);
        if (this.ctx.state === 'suspended') await this.ctx.resume();
      } catch (err) {
        this._emit('playback-error', new Error(
          `cannot route audio to “${this.outputLabel || 'the selected device'}” `
          + `(${err.name}: ${err.message}).`));
      }

      el.srcObject = this.remoteStream;
      try {
        await el.play();
      } catch (err) {
        this._emit('playback-error', new Error(`playback was blocked: ${err.message}`));
      }

      // Serialised by hand: Electron's console bridge flattens objects to
      // "[object Object]" on the way to the terminal.
      const track = this.remoteStream.getAudioTracks()[0];
      console.info(`[${this.name}] playback attached ` + JSON.stringify({
        contextSink: this.ctx ? (this.ctx.sinkId || 'default') : 'none',
        contextState: this.ctx ? this.ctx.state : 'none',
        inDocument: el.isConnected,
        requested: this.outputDeviceId,
        label: this.outputLabel,
        muted: track ? track.muted : null,
        readyState: track ? track.readyState : null,
        volume: el.volume,
        paused: el.paused,
      }));

      // A remote WebRTC track starts out muted and unmutes when media actually
      // arrives. If it never unmutes, the session is fine and the transcripts
      // keep coming, but there is no audio to play — a completely different
      // fault from routing to the wrong device, and indistinguishable by ear.
      if (track) {
        track.addEventListener('unmute', () => {
          console.info(`[${this.name}] remote audio flowing`);
          this._emit('audio-flowing', { flowing: true });
        });
        track.addEventListener('mute', () => {
          console.warn(`[${this.name}] remote audio stalled`);
          this._emit('audio-flowing', { flowing: false });
        });
        setTimeout(() => {
          if (this._stopped || !this.audioEl) return;
          if (track.muted) {
            this._emit('playback-error', new Error(
              'the translated audio track never started. Transcripts still arrive, '
              + 'so the session is healthy — this is a media path problem.'));
          }
        }, 12000);
      }

      this._emit('playback', { stream: this.remoteStream, element: el });
    }

    async stop() {
      this._stopped = true;
      await this._teardown();
      this._setState('stopped');
    }

    async _teardown() {
      if (this.dc) {
        try { this.dc.close(); } catch { /* already closed */ }
        this.dc = null;
      }
      if (this.pc) {
        try { this.pc.close(); } catch { /* already closed */ }
        this.pc = null;
      }
      if (this.srcNode) {
        try { this.srcNode.disconnect(); } catch { /* already gone */ }
        this.srcNode = null;
      }
      this.gain = null;
      if (this.ctx) {
        try { await this.ctx.close(); } catch { /* already closed */ }
        this.ctx = null;
      }
      if (this.audioEl) {
        this.audioEl.pause();
        this.audioEl.srcObject = null;
        this.audioEl.remove();
        this.audioEl = null;
      }
      if (this.stream) {
        for (const track of this.stream.getTracks()) track.stop();
        this.stream = null;
      }
      this.track = null;
      this.remoteStream = null;
      this._segments.clear();
    }

    // ----------------------------------------------------------- controls --

    setMuted(muted) {
      if (this.track) this.track.enabled = !muted;
      this._emit('mute', { muted: this.isMuted });
    }

    get isMuted() {
      return this.track ? !this.track.enabled : this.startMuted;
    }

    setOutputVolume(volume) {
      this.outputVolume = volume;
      if (this.gain) this.gain.gain.value = volume;
    }

    /** Moves playback to another device without tearing the session down. */
    async setOutputDevice(deviceId) {
      this.outputDeviceId = deviceId || '';
      if (this.ctx && typeof this.ctx.setSinkId === 'function') {
        await this.ctx.setSinkId(this.outputDeviceId);
      }
    }

    // ------------------------------------------------------ server events --

    _onServerEvent(raw) {
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        return;
      }

      const type = event.type || '';

      // Source-language transcript (only when transcription is enabled).
      if (type.endsWith('input_transcript.delta')) {
        this._lastSourceAt = performance.now();
        this._segment(event).source += event.delta || '';
        return this._flush(event, false);
      }
      if (type.endsWith('input_transcript.done')) {
        const seg = this._segment(event);
        if (event.transcript) seg.source = event.transcript;
        return this._flush(event, false);
      }

      // Translated transcript, which arrives alongside the translated audio.
      if (type.endsWith('output_transcript.delta')) {
        const seg = this._segment(event);
        if (!seg.firstOutputAt) {
          seg.firstOutputAt = performance.now();
          if (this._lastSourceAt) {
            this._emit('lag', { ms: Math.round(seg.firstOutputAt - this._lastSourceAt) });
          }
        }
        seg.translated += event.delta || '';
        return this._flush(event, false);
      }
      if (type.endsWith('output_transcript.done')) {
        const seg = this._segment(event);
        if (event.transcript) seg.translated = event.transcript;
        this._flush(event, true);
        this._segments.delete(segmentKey(event));
        return;
      }

      if (type === 'output_audio_buffer.started' || type === 'output_audio_buffer.stopped') {
        this._emit('speaking', { speaking: type.endsWith('started') });
        return;
      }
      if (type === 'session.created' || type === 'session.updated') return;

      if (type === 'error' || event.error) {
        const message = (event.error && event.error.message) || 'Realtime API error';
        this._emit('error', new Error(message));
        return;
      }

      if (!this._unknownEvents.has(type)) {
        this._unknownEvents.add(type);
        console.debug(`[${this.name}] unhandled event ${type} ` + JSON.stringify(event));
      }
    }

    _segment(event) {
      const key = segmentKey(event);
      const existing = this._segments.get(key);
      const now = performance.now();

      // If the endpoint never sends a matching *.done — or reuses one id for a
      // whole session — a single caption would grow without bound. Treat a long
      // quiet gap as a paragraph break so the feed stays readable either way.
      if (existing && now - existing.lastAt > SEGMENT_GAP_MS) {
        this._emit('line', {
          id: existing.id,
          direction: this.name,
          at: existing.at,
          source: existing.source,
          translated: existing.translated,
          done: true,
        });
        this._segments.delete(key);
      }

      if (!this._segments.has(key)) {
        this._segments.set(key, {
          id: `${this.name}-${key}-${this._segmentSeq++}`,
          at: Date.now(),
          lastAt: now,
          source: '',
          translated: '',
          firstOutputAt: 0,
        });
      }

      const seg = this._segments.get(key);
      seg.lastAt = now;
      return seg;
    }

    _flush(event, done) {
      const seg = this._segments.get(segmentKey(event));
      if (!seg) return;
      this._emit('line', {
        id: seg.id,
        direction: this.name,
        at: seg.at,
        source: seg.source,
        translated: seg.translated,
        done,
      });
    }
  }

  /**
   * getUserMedia's own errors name neither the lane nor the device, which makes
   * a two-lane failure impossible to place. Wrap them, and retry once on
   * NotReadableError — a device released moments earlier (by the device test, or
   * by a lane that just stopped) is briefly still held by the OS.
   */
  async function openCapture(audio, laneLabel, deviceLabel, retried) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio, video: false });
    } catch (err) {
      if (err.name === 'NotReadableError' && !retried) {
        await new Promise((resolve) => setTimeout(resolve, 600));
        return openCapture(audio, laneLabel, deviceLabel, true);
      }

      const where = `${laneLabel} lane, input “${deviceLabel || 'default device'}”`;
      if (err.name === 'NotReadableError') {
        throw new Error(`${where}: the device is busy. Another application is holding it — `
          + 'close it, or pick a different input.');
      }
      if (err.name === 'OverconstrainedError' || err.name === 'NotFoundError') {
        throw new Error(`${where}: device not found. Press the refresh button in Setup.`);
      }
      if (err.name === 'NotAllowedError') {
        throw new Error(`${where}: microphone access denied by Windows privacy settings.`);
      }
      throw new Error(`${where}: ${err.name} — ${err.message}`);
    }
  }

  /** Translation events carry no single stable id field, so try the usual suspects. */
  function segmentKey(event) {
    return event.item_id || event.segment_id || event.response_id || event.id || 'current';
  }

  /**
   * OpenAI's realtime endpoint takes a complete offer rather than trickled
   * candidates. Waiting forever would hang the UI on a flaky network, so cap it
   * and send whatever has been gathered.
   */
  function waitForIceGathering(pc) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => {
        if (pc.iceGatheringState === 'complete') done();
      };
      const timer = setTimeout(done, ICE_GATHER_TIMEOUT_MS);
      pc.addEventListener('icegatheringstatechange', check);
    });
  }

  VB.TranslationLane = TranslationLane;
  // The local engine opens its capture the same way and wants the same
  // lane-aware error messages, so share the helper rather than copying it.
  VB.openCapture = openCapture;
})(window.VB = window.VB || {});
