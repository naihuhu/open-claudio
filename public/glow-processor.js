// glow-processor.js — AudioWorklet processor for audio-reactive ambient glow.
// Runs on the audio thread (not the main thread), so feature extraction never
// competes with rendering — the key fix for Windows where rAF timing jitters
// at the default 15.6 ms timer resolution.
//
// For each 128-sample Web Audio block we:
//   1. Copy input → output (transparent pass-through, audio keeps playing).
//   2. Accumulate RMS (overall loudness) and bass RMS (one-pole LP at ~300 Hz,
//      matching the original Meyda bark-band coverage of 0–300 Hz).
//   3. Every 4 blocks (512 samples ≈ 11.6 ms) post { rms, bassRms } to the
//      main thread, which pushes it into a ring buffer. The glow rAF loop
//      reads from that buffer with time-based interpolation — smooth output
//      regardless of rAF jitter.

class GlowProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // One-pole IIR low-pass for bass extraction.
    // alpha ≈ 0.043 → cutoff ≈ 0.043 × 44100 / (2π) ≈ 300 Hz
    // This covers the kick drum's fundamental (50–100 Hz) plus the "punch"
    // range (100–300 Hz), matching what Meyda's bark bands 0–2 captured.
    this._bass = 0;
    this._alpha = 0.043;
    // Accumulate 4 blocks (4 × 128 = 512 samples) before posting — matches
    // the old Meyda bufferSize and keeps MessagePort traffic at ~86 Hz.
    this._blockCount = 0;
    this._accSumSq = 0;
    this._accBassSumSq = 0;
    this._accSamples = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    // Pass audio through unchanged so playback continues as normal.
    if (input && output) {
      for (let ch = 0; ch < output.length; ch++) {
        // Mix down to mono for analysis if the input has channels.
        const src = input[ch] || input[0];
        if (src) output[ch].set(src);
      }
    }

    // Analyse the first channel (mono-compatible).
    const data = input && input[0];
    if (!data || data.length === 0) return true;

    for (let i = 0; i < data.length; i++) {
      const s = data[i];
      this._accSumSq += s * s;
      // One-pole LP: y[n] = y[n-1] + α·(x[n] − y[n-1])
      this._bass += this._alpha * (s - this._bass);
      this._accBassSumSq += this._bass * this._bass;
      this._accSamples++;
    }

    this._blockCount++;
    if (this._blockCount >= 4) {
      const n = this._accSamples || 1;
      this.port.postMessage({
        rms: Math.sqrt(this._accSumSq / n),
        bassRms: Math.sqrt(this._accBassSumSq / n),
      });
      this._accSumSq = 0;
      this._accBassSumSq = 0;
      this._accSamples = 0;
      this._blockCount = 0;
    }

    return true;
  }
}

registerProcessor('glow-processor', GlowProcessor);
