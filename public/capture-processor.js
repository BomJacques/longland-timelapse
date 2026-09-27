/* One persistent mono PCM gate. All capture lengths, cooldowns and detector
 * windows are counted in audio frames; no main-thread timer gates the sound. */
class LonglandCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.rate = typeof sampleRate === 'number' ? sampleRate : 48000;
    this.position = 0;
    this.captureIndex = -1;
    this.remaining = 0;
    this.total = 0;
    this.pending = new Float32Array(4096);
    this.pendingLength = 0;
    this.history = new Float32Array(Math.ceil(this.rate * 0.5));
    this.historyWrite = 0;
    this.historySize = 0;
    this.armed = false;
    this.config = null;
    this.nextAllowed = 0;
    this.deadline = Infinity;
    this.latched = false;
    this.releaseFrames = 0;
    this.energy = 0;
    this.energyCount = 0;
    this.baseline = 0.00001;
    this.speechVotes = 0;
    this.vad = null;
    this.vadGeneration = 0;
    this.resetResampler();
    this.port.onmessage = ({ data }) => {
      if (data.type === 'start') { this.armed = false; this.start(data.captureIndex, data.frameCount); }
      else if (data.type === 'stop') { this.armed = false; this.deadline = Infinity; this.finish(); }
      else if (data.type === 'reset') { this.disarm(); this.captureIndex = -1; this.remaining = 0; this.pendingLength = 0; }
      else if (data.type === 'disarm') this.disarm();
      else if (data.type === 'arm') {
        this.config = data;
        this.armed = true;
        this.deadline = Number.isFinite(data.sessionFrames) ? this.position + Math.max(0, data.sessionFrames) : Infinity;
      } else if (data.type === 'vad-init') void this.initVad(data.binary, data.mode);
    };
  }

  resetResampler() {
    this.resampleNeed = this.rate / 16000;
    this.resampleSum = 0;
    this.speechFrame = new Int16Array(160);
    this.speechOffset = 0;
  }

  async initVad(binary, mode) {
    const generation = ++this.vadGeneration;
    try {
      const { instance } = await WebAssembly.instantiate(binary);
      if (generation !== this.vadGeneration) return;
      const api = instance.exports;
      const handle = api.fvad_new();
      if (!handle || api.fvad_set_mode(handle, mode) < 0 || api.fvad_set_sample_rate(handle, 16000) < 0) throw new Error('Could not initialise speech detector.');
      const pointer = api.malloc(320);
      if (!pointer) throw new Error('Speech detector could not allocate its frame buffer.');
      this.vad = { api, handle, pointer };
      this.port.postMessage({ type: 'vad-ready' });
    } catch (error) { this.port.postMessage({ type: 'vad-error', message: String(error) }); }
  }

  disarm() {
    this.armed = false; this.deadline = Infinity;
    this.historySize = 0; this.historyWrite = 0;
    this.energy = 0; this.energyCount = 0; this.baseline = 0.00001;
    this.latched = false; this.releaseFrames = 0; this.speechVotes = 0;
    this.resetResampler();
    if (this.vad?.api.fvad_reset) {
      this.vad.api.fvad_reset(this.vad.handle);
      this.vad.api.fvad_set_mode(this.vad.handle, this.config?.speechMode ?? 2);
      this.vad.api.fvad_set_sample_rate(this.vad.handle, 16000);
    }
  }

  start(index, frames) {
    this.captureIndex = index; this.remaining = Math.max(0, Math.floor(frames));
    this.total = 0; this.pendingLength = 0;
    if (!this.remaining) this.finish();
  }

  append(value) {
    if (this.captureIndex < 0 || this.remaining <= 0) return;
    this.pending[this.pendingLength++] = value;
    this.remaining--; this.total++;
    if (this.pendingLength === this.pending.length || this.remaining === 0) this.flush();
    if (!this.remaining) this.finish();
  }

  flush() {
    if (!this.pendingLength) return;
    const samples = this.pending.slice(0, this.pendingLength);
    this.port.postMessage({ type: 'chunk', captureIndex: this.captureIndex, samples: samples.buffer }, [samples.buffer]);
    this.pendingLength = 0;
  }

  finish() {
    if (this.captureIndex < 0) return;
    const index = this.captureIndex, remaining = this.remaining;
    this.flush(); this.captureIndex = -1; this.remaining = 0;
    this.nextAllowed = this.position + Math.round((this.config?.retriggerMs ?? 0) * this.rate / 1000);
    this.port.postMessage({ type: 'complete', captureIndex: index, frames: this.total, remainingFrames: remaining });
  }

  trigger() {
    if (!this.armed || !this.config || this.captureIndex >= 0 || this.position < this.nextAllowed || this.position >= this.deadline) return;
    const config = this.config;
    const preRoll = Math.min(this.historySize, Math.round(config.preRollMs * this.rate / 1000), Math.floor(config.frameCount / 2));
    const frames = Math.min(config.frameCount, Math.max(0, this.deadline - this.position) + preRoll);
    if (!frames) return;
    this.armed = false;
    this.start(config.captureIndex, frames);
    this.port.postMessage({ type: 'trigger', captureIndex: config.captureIndex, frames, preRollFrames: preRoll });
    for (let i = 0; i < preRoll; i++) this.append(this.history[(this.historyWrite - preRoll + i + this.history.length) % this.history.length]);
  }

  detectorDecision(active, windowFrames, holdFrames) {
    if (active) {
      this.releaseFrames = 0;
      if (!this.latched) { this.latched = true; this.trigger(); }
    } else {
      this.releaseFrames += windowFrames;
      if (this.releaseFrames >= holdFrames) this.latched = false;
    }
  }

  speech(value) {
    // Weighted box-filter resampling with retained fractional phase (44.1/48 kHz).
    let weight = 1;
    while (weight > 1e-9) {
      const used = Math.min(weight, this.resampleNeed);
      this.resampleSum += value * used; this.resampleNeed -= used; weight -= used;
      if (this.resampleNeed < 1e-9) {
        const sample = Math.max(-1, Math.min(1, this.resampleSum / (this.rate / 16000)));
        this.speechFrame[this.speechOffset++] = Math.round(sample * (sample < 0 ? 32768 : 32767));
        this.resampleNeed = this.rate / 16000; this.resampleSum = 0;
        if (this.speechOffset === 160) {
          this.speechOffset = 0;
          const { api, handle, pointer } = this.vad;
          new Int16Array(api.memory.buffer, pointer, 160).set(this.speechFrame);
          const result = api.fvad_process(handle, pointer, 160);
          if (result < 0) { this.disarm(); this.port.postMessage({ type: 'vad-error', message: 'Speech analysis failed.' }); return; }
          this.speechVotes = result === 1 ? this.speechVotes + 1 : 0;
          this.detectorDecision(this.speechVotes >= 3, this.rate / 100, this.rate * 0.15);
        }
      }
    }
  }

  process(inputs, outputs) {
    outputs[0]?.forEach((channel) => channel.fill(0));
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      this.position++;
      let mono = 0;
      for (const channel of channels) mono += (channel[i] || 0) / channels.length;
      this.append(mono);
      if (this.position >= this.deadline) {
        this.armed = false; this.deadline = Infinity; this.finish();
        this.port.postMessage({ type: 'session-ended' });
      }
      if (!this.config || (!this.armed && this.captureIndex < 0)) continue;
      this.history[this.historyWrite] = mono;
      this.historyWrite = (this.historyWrite + 1) % this.history.length;
      this.historySize = Math.min(this.history.length, this.historySize + 1);
      if (this.config.recordingMode === 'speech') { if (this.vad) this.speech(mono); continue; }
      this.energy += mono * mono; this.energyCount++;
      if (this.energyCount >= Math.round(this.rate * 0.005)) {
        const rms = Math.sqrt(this.energy / this.energyCount);
        const threshold = Math.pow(10, this.config.thresholdDb / 20);
        const percussive = this.config.recordingMode === 'percussive';
        const active = rms >= threshold && (!percussive || rms >= this.baseline * Math.pow(10, this.config.onsetDb / 20));
        this.detectorDecision(active || (!percussive && this.latched && rms >= threshold * 0.6), this.energyCount, this.rate * (percussive ? 0.015 : 0.08));
        this.baseline = this.baseline * 0.95 + rms * 0.05;
        this.energy = 0; this.energyCount = 0;
      }
    }
    return true;
  }
}
registerProcessor('longland-capture', LonglandCaptureProcessor);
