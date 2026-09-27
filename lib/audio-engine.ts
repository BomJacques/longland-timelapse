import { floatToPcm16, phase2Settings, secondsToFrames, type RecorderSettings } from './audio-core';

type InputEvent = 'muted' | 'unmuted' | 'ended' | 'context-suspended';

export class AudioEngine {
  context: AudioContext | null = null;
  stream: MediaStream | null = null;
  sampleRate = 48000;
  activeDeviceLabel = 'System default';
  private source: AudioNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private analyser: AnalyserNode | null = null;
  private silentGain: GainNode | null = null;
  private oscillator: OscillatorNode | null = null;
  private syntheticSource: AudioBufferSourceNode | null = null;
  private meterData = new Float32Array(128);
  inputDb = -100;
  onChunk?: (captureIndex: number, samples: Int16Array) => void;
  onCaptureComplete?: (captureIndex: number, frames: number, remainingFrames: number) => void;
  onInputEvent?: (event: InputEvent) => void;
  onTriggered?: (captureIndex: number, frames: number, preRollFrames: number) => void;
  onSessionEnd?: () => void;
  onError?: (message: string) => void;
  private speechReady?: { resolve: () => void; reject: (error: Error) => void };

  async initialize(deviceId = '', synthetic = false) {
    if (!window.isSecureContext && location.hostname !== 'localhost') throw new Error('Microphone access requires HTTPS. Open the secure hosted version of this page.');
    if (!navigator.mediaDevices?.getUserMedia && !synthetic) throw new Error('This browser does not provide microphone access. Use current Safari, Chrome, or Edge.');
    if (!('AudioContext' in window || 'webkitAudioContext' in window)) throw new Error('Web Audio is not supported by this browser.');

    const AudioContextClass = window.AudioContext ?? (window as typeof window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const context = new AudioContextClass({ latencyHint: 'interactive' });
    const resumePromise = context.resume();
    const mediaPromise = synthetic
      ? Promise.resolve(null)
      : navigator.mediaDevices.getUserMedia({ audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), channelCount: { ideal: 1 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    // Start the new context and permission request before the first await so Safari
    // still associates both with the button's transient user activation.
    const cleanupPromise = this.destroy();
    const [mediaResult, resumeResult] = await Promise.all([Promise.resolve(mediaPromise).then(
      (value) => ({ ok: true as const, value }), (reason) => ({ ok: false as const, reason }),
    ), resumePromise.then(
      () => ({ ok: true as const }), (reason) => ({ ok: false as const, reason }),
    ), cleanupPromise]).then(([media, resume]) => [media, resume] as const);
    if (!mediaResult.ok || !resumeResult.ok || context.state !== 'running') {
      if (mediaResult.ok) mediaResult.value?.getTracks().forEach((track) => track.stop());
      await context.close().catch(() => undefined);
      throw (!mediaResult.ok ? mediaResult.reason : !resumeResult.ok ? resumeResult.reason : new Error('Safari did not start the audio system. Tap the button again and make sure sound is allowed.'));
    }
    const stream = mediaResult.value;
    this.context = context; this.stream = stream; this.sampleRate = context.sampleRate;
    try {
    await context.audioWorklet.addModule('/capture-processor.js');
    this.worklet = new AudioWorkletNode(context, 'longland-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.worklet.port.onmessage = (event: MessageEvent<{ type: string; captureIndex: number; samples?: ArrayBuffer; frames?: number; remainingFrames?: number; preRollFrames?: number; message?: string }>) => {
      const message = event.data;
      if (message.type === 'chunk' && message.samples) this.onChunk?.(message.captureIndex, floatToPcm16(new Float32Array(message.samples)));
      if (message.type === 'complete') this.onCaptureComplete?.(message.captureIndex, message.frames ?? 0, message.remainingFrames ?? 0);
      if (message.type === 'trigger') this.onTriggered?.(message.captureIndex, message.frames ?? 0, message.preRollFrames ?? 0);
      if (message.type === 'session-ended') this.onSessionEnd?.();
      if (message.type === 'vad-ready') { this.speechReady?.resolve(); this.speechReady = undefined; }
      if (message.type === 'vad-error') {
        const error = new Error(message.message ?? 'Speech detection failed.');
        if (this.speechReady) { this.speechReady.reject(error); this.speechReady = undefined; }
        else this.onError?.(error.message);
      }
    };
    this.worklet.onprocessorerror = () => this.onError?.('Audio processing stopped unexpectedly. Your saved audio can still be exported.');

    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 256;
    this.analyser.smoothingTimeConstant = 0.72;
    this.meterData = new Float32Array(this.analyser.fftSize);
    this.silentGain = context.createGain();
    this.silentGain.gain.value = 0;

    if (synthetic) {
      const fixture = new URLSearchParams(location.search).get('fixture');
      if (fixture === 'speech' || fixture === 'pulses') {
        let buffer: AudioBuffer;
        if (fixture === 'speech') {
          const response = await fetch('/debug/speech16.wav');
          if (!response.ok) throw new Error('Debug speech fixture could not load.');
          buffer = await context.decodeAudioData(await response.arrayBuffer());
        } else {
          buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
          const data = buffer.getChannelData(0);
          for (let i = 0; i < Math.round(context.sampleRate * 0.08); i++) data[i + Math.round(context.sampleRate * 0.5)] = Math.sin(i * 2 * Math.PI * 440 / context.sampleRate) * Math.exp(-i / (context.sampleRate * 0.015)) * 0.8;
        }
        this.syntheticSource = context.createBufferSource(); this.syntheticSource.buffer = buffer; this.syntheticSource.loop = true;
        this.source = this.syntheticSource; this.syntheticSource.start();
        this.activeDeviceLabel = fixture === 'speech' ? 'Debug: libfvad speech fixture (not microphone)' : 'Debug: generated percussive pulses (not microphone)';
      } else {
      this.oscillator = context.createOscillator();
      this.oscillator.frequency.value = 440;
      this.source = this.oscillator;
      this.activeDeviceLabel = 'Synthetic 440 Hz test tone';
      this.oscillator.start();
      }
    } else {
      this.source = context.createMediaStreamSource(stream!);
      const track = stream!.getAudioTracks()[0];
      this.activeDeviceLabel = track.label || 'Active microphone';
      track.addEventListener('mute', () => { if (this.stream === stream) this.onInputEvent?.('muted'); });
      track.addEventListener('unmute', () => { if (this.stream === stream) this.onInputEvent?.('unmuted'); });
      track.addEventListener('ended', () => { if (this.stream === stream) this.onInputEvent?.('ended'); });
    }
    context.addEventListener('statechange', () => { if (this.context === context && ['suspended', 'interrupted'].includes(context.state)) this.onInputEvent?.('context-suspended'); });
    this.source.connect(this.analyser);
    this.source.connect(this.worklet);
    this.worklet.connect(this.silentGain).connect(context.destination);
    } catch (error) { await this.destroy(); throw error; }
  }

  async prepareSpeech(mode: number) {
    const response = await fetch('/vendor/vad/libfvad.wasm');
    if (!response.ok) throw new Error('Speech detector could not load. Check your connection and try again.');
    const binary = await response.arrayBuffer();
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => { this.speechReady = undefined; reject(new Error('Speech detector took too long to start. Try again.')); }, 10000);
      this.speechReady = { resolve: () => { clearTimeout(timeout); resolve(); }, reject: (error) => { clearTimeout(timeout); reject(error); } };
      this.worklet?.port.postMessage({ type: 'vad-init', binary, mode }, [binary]);
    });
  }

  arm(settings: RecorderSettings, index: number, secondsRemaining: number | null) {
    this.worklet?.port.postMessage({ ...phase2Settings(settings), type: 'arm', captureIndex: index,
      frameCount: secondsToFrames(settings.captureSeconds, this.sampleRate),
      sessionFrames: secondsRemaining === null ? null : secondsToFrames(secondsRemaining, this.sampleRate),
    });
  }
  disarm() { this.worklet?.port.postMessage({ type: 'disarm' }); }

  startCapture(captureIndex: number, frameCount: number) {
    if (!this.worklet) throw new Error('Audio engine is not ready.');
    this.worklet.port.postMessage({ type: 'start', captureIndex, frameCount });
  }

  stopCapture() { this.worklet?.port.postMessage({ type: 'stop' }); }
  cancelCapture() { this.worklet?.port.postMessage({ type: 'reset' }); }

  async resume() {
    if (!this.context) throw new Error('Audio engine is not ready.');
    if (this.context.state !== 'running') await this.context.resume();
    if (this.context.state !== 'running') throw new Error('Safari kept the audio system suspended. Tap Resume again while Safari is in the foreground.');
  }

  level() {
    if (!this.analyser) return 0;
    this.analyser.getFloatTimeDomainData(this.meterData);
    let sum = 0;
    for (const value of this.meterData) sum += value * value;
    const rms = Math.sqrt(sum / this.meterData.length);
    this.inputDb = 20 * Math.log10(Math.max(0.00001, rms));
    return Math.min(1, rms * 3.2);
  }

  async inputs() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    return (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput');
  }

  async destroy() {
    const context = this.context, stream = this.stream;
    this.context = null; this.stream = null;
    this.speechReady?.reject(new Error('Speech detector was stopped.')); this.speechReady = undefined;
    if (this.worklet) { this.worklet.port.onmessage = null; this.worklet.onprocessorerror = null; }
    this.worklet?.port.postMessage({ type: 'reset' });
    this.worklet?.disconnect();
    this.source?.disconnect();
    this.analyser?.disconnect();
    this.silentGain?.disconnect();
    this.oscillator?.stop();
    this.syntheticSource?.stop(); this.syntheticSource = null;
    stream?.getTracks().forEach((track) => track.stop());
    if (context && context.state !== 'closed') await context.close().catch(() => undefined);
    this.context = null; this.stream = null; this.source = null; this.worklet = null; this.analyser = null; this.silentGain = null; this.oscillator = null;
  }
}
