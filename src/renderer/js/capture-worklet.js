/**
 * Capture worklet for the local engine.
 *
 * Runs on the audio thread, batches the 128-sample blocks Chromium hands it
 * into 40 ms chunks, converts to Int16 and posts them to the lane. The
 * conversion happens here rather than on the main thread because a garbage
 * collection pause on the main thread would otherwise drop microphone audio.
 *
 * The context that hosts this is constructed at 16 kHz, so no resampling is
 * needed — Chromium resamples the device to the context rate for us.
 */

const CHUNK = 640; // 40 ms at 16 kHz

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(CHUNK);
    this.filled = 0;
    this.muted = false;
    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'mute') this.muted = Boolean(event.data.on);
    };
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || this.muted) return true;

    for (let i = 0; i < channel.length; i += 1) {
      this.buffer[this.filled] = channel[i];
      this.filled += 1;
      if (this.filled === CHUNK) {
        const pcm = new Int16Array(CHUNK);
        for (let k = 0; k < CHUNK; k += 1) {
          // Clamp before scaling: a sample above 1.0 would wrap to a loud
          // negative and read as a click to the voice detector.
          const s = Math.max(-1, Math.min(1, this.buffer[k]));
          pcm[k] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        this.port.postMessage(pcm, [pcm.buffer]);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('voiceb-capture', CaptureProcessor);
