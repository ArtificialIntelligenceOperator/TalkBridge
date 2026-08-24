/**
 * Audio plumbing for the renderer: device discovery, routing guesses, level
 * meters, and the low-volume passthrough of the original remote voice.
 */
(function (VB) {
  'use strict';

  const CABLE_HINTS = ['cable', 'vb-audio', 'vb audio', 'voicemeeter'];

  let sharedContext = null;

  function audioContext() {
    if (!sharedContext) sharedContext = new AudioContext();
    if (sharedContext.state === 'suspended') sharedContext.resume();
    return sharedContext;
  }

  /**
   * Device labels stay blank until the page has been granted microphone
   * access at least once, so take a throwaway capture first.
   */
  async function ensurePermission() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      for (const track of stream.getTracks()) track.stop();
      return true;
    } catch (err) {
      console.warn('[audio] microphone permission denied', err);
      return false;
    }
  }

  async function listDevices() {
    const all = await navigator.mediaDevices.enumerateDevices();
    const inputs = [];
    const outputs = [];
    for (const d of all) {
      if (d.kind === 'audioinput') inputs.push(toDevice(d, inputs.length));
      if (d.kind === 'audiooutput') outputs.push(toDevice(d, outputs.length));
    }
    return { inputs, outputs };
  }

  function toDevice(device, index) {
    const label = device.label || `Device ${index + 1}`;
    return {
      deviceId: device.deviceId,
      label,
      isCable: isCable(label),
      isDefault: device.deviceId === 'default' || device.deviceId === 'communications',
    };
  }

  /**
   * Whether a device looks like a software loopback rather than real hardware.
   * Besides the known product names, anything calling itself "virtual …audio"
   * counts — that catches devices we have never heard of, such as the audio
   * driver shipped with Virtual Desktop.
   */
  function isCable(label) {
    const lower = String(label).toLowerCase();
    if (CABLE_HINTS.some((hint) => lower.includes(hint))) return true;
    return lower.includes('virtual') && /\b(audio|sound|mic|speaker)/.test(lower);
  }

  /**
   * First-run guesses so the setup panel starts from something sensible:
   *   mic          — first non-cable input
   *   toCall       — cable output device (what the meeting app should listen to)
   *   fromCall     — a *second* cable input, distinct from toCall
   *   headphones   — first non-cable output
   *
   * A cable is a loop: its render side is named "CABLE Input" and its capture
   * side "CABLE Output". We play into the render side and read from the capture
   * side of the other cable, so the two must never be the same device.
   */
  function guessRouting(devices) {
    const cableOut = devices.outputs.filter((d) => d.isCable && !d.isDefault);
    const cableIn = devices.inputs.filter((d) => d.isCable && !d.isDefault);
    const plainOut = devices.outputs.filter((d) => !d.isCable && !d.isDefault);
    const plainIn = devices.inputs.filter((d) => !d.isCable && !d.isDefault);

    const toCall = cableOut[0] || null;
    // The inbound lane must read from a different cable than the outbound lane
    // writes to, or we would capture our own translated voice.
    const fromCall = pickDistinctCable(cableIn, toCall);

    return {
      micDeviceId: (plainIn[0] || devices.inputs[0] || {}).deviceId || '',
      toCallDeviceId: toCall ? toCall.deviceId : '',
      fromCallDeviceId: fromCall ? fromCall.deviceId : '',
      headphonesDeviceId: (plainOut[0] || devices.outputs[0] || {}).deviceId || '',
    };
  }

  /** Cable render/capture sides share a family name; prefer a different family. */
  function pickDistinctCable(candidates, taken) {
    if (!candidates.length) return null;
    if (!taken) return candidates[0];
    const takenFamily = cableFamily(taken.label);
    const other = candidates.find((d) => cableFamily(d.label) !== takenFamily);
    return other || null;
  }

  /**
   * Identifies the physical headset behind a Bluetooth endpoint, ignoring which
   * profile it is. Windows exposes one headset twice — "Headset (X Hands-Free)"
   * for the mic and "Headphones (X Stereo)" for playback — but the radio can
   * only run one profile at a time, so using both at once simply fails.
   * Returns '' for anything that is not a Bluetooth endpoint.
   */
  function bluetoothFamily(label) {
    const text = String(label);
    if (!/bluetooth|hands-?free/i.test(text)) return '';
    const groups = Array.from(text.matchAll(/\(([^)]*)\)/g), (m) => m[1]);
    const name = groups.find((g) => !/^\s*bluetooth\s*$/i.test(g)) || text;
    return name
      .toLowerCase()
      .replace(/hands-?free|stereo|headset|headphones|\bav\b/g, '')
      .replace(/[^a-z0-9]/g, '');
  }

  /**
   * Distinguishes loudspeakers from anything worn on the head. Open speakers
   * plus an open microphone is an acoustic loop: the translation comes out of
   * the speakers, the mic hears it, and it gets translated right back.
   */
  function looksLikeSpeakers(label) {
    const lower = String(label).toLowerCase();
    if (/наушник|headphone|headset|earbud|earphone|handsfree|hands-free/.test(lower)) return false;
    return /динамик|speaker|колонк/.test(lower);
  }

  function cableFamily(label) {
    return String(label)
      .toLowerCase()
      .replace(/\b(input|output|in|out)\b/g, '')
      .replace(/[^a-z0-9]/g, '');
  }

  // ------------------------------------------------------------- metering --

  /**
   * Drives a 0..1 loudness value off a MediaStream. One rAF loop per meter is
   * fine here — we run at most three.
   */
  class Meter {
    constructor(stream, onLevel) {
      this.onLevel = onLevel;
      this.running = true;

      const ctx = audioContext();
      this.source = ctx.createMediaStreamSource(stream);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.analyser.smoothingTimeConstant = 0.6;
      this.source.connect(this.analyser);
      this.buffer = new Float32Array(this.analyser.fftSize);

      this._tick = this._tick.bind(this);
      requestAnimationFrame(this._tick);
    }

    _tick() {
      if (!this.running) return;
      this.analyser.getFloatTimeDomainData(this.buffer);
      let sum = 0;
      for (let i = 0; i < this.buffer.length; i++) sum += this.buffer[i] * this.buffer[i];
      const rms = Math.sqrt(sum / this.buffer.length);
      // Perceptual-ish curve: quiet speech should still move the bar.
      this.onLevel(Math.min(1, Math.pow(rms * 6, 0.6)));
      requestAnimationFrame(this._tick);
    }

    stop() {
      this.running = false;
      try {
        this.source.disconnect();
      } catch { /* already gone */ }
      this.onLevel(0);
    }
  }

  /**
   * Plays a stream to a chosen output at reduced volume. Used to keep the
   * speaker's original voice faintly audible under the translation, which makes
   * the conversation far easier to follow than translation alone.
   */
  class Passthrough {
    constructor(stream, deviceId, volume) {
      // Same ordering rule as TranslationLane: in the document first, then pick
      // the sink, and only then attach media. Attaching media earlier lets
      // Chromium open the render stream on the default device and stay there.
      this.el = new Audio();
      this.el.autoplay = false;
      this.el.volume = volume;
      this.el.style.display = 'none';
      document.body.appendChild(this.el);

      this.ready = (async () => {
        if (typeof this.el.setSinkId === 'function') {
          try {
            await this.el.setSinkId(deviceId || '');
          } catch (err) {
            console.warn('[audio] passthrough sink failed', err);
          }
        }
        if (this.stopped) return;
        this.el.srcObject = stream;
        try {
          await this.el.play();
        } catch (err) {
          console.warn('[audio] passthrough play failed', err);
        }
      })();
    }

    setVolume(volume) {
      this.el.volume = volume;
    }

    stop() {
      this.stopped = true;
      this.el.pause();
      this.el.srcObject = null;
      this.el.remove();
    }
  }

  VB.audio = {
    ensurePermission,
    listDevices,
    guessRouting,
    isCable,
    cableFamily,
    bluetoothFamily,
    looksLikeSpeakers,
    Meter,
    Passthrough,
  };
})(window.VB = window.VB || {});
