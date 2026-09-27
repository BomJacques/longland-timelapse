/* Persistent PCM gate. Capture duration is enforced in sample frames so 10 ms windows do not depend on main-thread timers. */
class LonglandCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.captureIndex = -1;
    this.remaining = 0;
    this.total = 0;
    this.pending = [];
    this.pendingLength = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === 'start') {
        this.captureIndex = data.captureIndex;
        this.remaining = Math.max(0, Math.floor(data.frameCount));
        this.total = 0;
        this.pending = [];
        this.pendingLength = 0;
      } else if (data.type === 'stop') {
        this.finish();
      } else if (data.type === 'reset') {
        this.captureIndex = -1;
        this.remaining = 0;
        this.pending = [];
        this.pendingLength = 0;
      }
    };
  }

  flush() {
    if (!this.pendingLength) return;
    const joined = new Float32Array(this.pendingLength);
    let offset = 0;
    for (const part of this.pending) { joined.set(part, offset); offset += part.length; }
    this.port.postMessage({ type: 'chunk', captureIndex: this.captureIndex, samples: joined.buffer }, [joined.buffer]);
    this.pending = [];
    this.pendingLength = 0;
  }

  finish() {
    if (this.captureIndex < 0) return;
    const index = this.captureIndex;
    const remaining = this.remaining;
    this.flush();
    this.captureIndex = -1;
    this.remaining = 0;
    this.port.postMessage({ type: 'complete', captureIndex: index, frames: this.total, remainingFrames: remaining });
  }

  process(inputs, outputs) {
    const output = outputs[0]?.[0];
    if (output) output.fill(0);
    if (this.captureIndex < 0 || this.remaining <= 0) return true;
    const channels = inputs[0];
    if (!channels?.length) return true;
    const count = Math.min(channels[0].length, this.remaining);
    const mono = new Float32Array(count);
    for (let channel = 0; channel < channels.length; channel += 1) {
      for (let i = 0; i < count; i += 1) mono[i] += channels[channel][i] / channels.length;
    }
    this.pending.push(mono);
    this.pendingLength += count;
    this.remaining -= count;
    this.total += count;
    if (this.pendingLength >= 4096 || this.remaining === 0) this.flush();
    if (this.remaining === 0) this.finish();
    return true;
  }
}

registerProcessor('longland-capture', LonglandCaptureProcessor);
