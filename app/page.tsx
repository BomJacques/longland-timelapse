'use client';

import { useCallback, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import {
  AlertTriangle, Bluetooth, Check, CircleStop, Clipboard, Download,
  FileJson, Headphones, Mic2, Pause, Play, Radio, RotateCcw, Share2, ShieldCheck,
} from 'lucide-react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { NumberInput } from '@/components/number-input';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Progress } from '@/components/ui/progress';
import { RecordingModeControls, FadeControls, FadeEditor, MODE_NAMES } from '@/components/recorder-controls';
import { captureFrameBudget, captureSlot, isScheduled, scheduledCount } from '@/lib/sequence-core';
import { SequenceControls } from '@/components/sequence-controls';
import { exportWav } from '@/lib/export-engine';
import { AudioEngine } from '@/lib/audio-engine';
import {
  durationSeconds, filenameStamp, formatClock, formatAudio,
  secondsToFrames, validateSettings, wavHeader, phase2Settings, PHASE2_DEFAULTS,
  type FadeSettings,
  type CaptureRecord, type RecorderSettings, type SessionState,
} from '@/lib/audio-core';
import { SessionStore, type StoredChunk, type StoredSession } from '@/lib/session-store';

const INITIAL: RecorderSettings = {
  ...PHASE2_DEFAULTS,
  captureSeconds: 2, intervalSeconds: 30, durationValue: 1, durationUnit: 'hours',
  manualStop: false, transitionMs: 10, gapMs: 0, keepAwake: true, persist: true, deviceId: '',
};
const ACTIVE_STATES: SessionState[] = ['recording-capture', 'waiting', 'paused', 'stopping'];
const JITTER_GRACE_MS = 350;
const TEST_CAPTURE_INDEX = 2147483647;

const friendlyError = (error: unknown) => {
  const item = error as DOMException;
  if (item?.name === 'NotAllowedError') return 'Safari did not allow microphone access. Check Settings → Safari → Microphone, then reload this page.';
  if (item?.name === 'NotFoundError') return 'No microphone is available. Connect your AirPods, Bluetooth earpiece, or another microphone and try again.';
  if (item?.name === 'OverconstrainedError') return 'The chosen microphone is no longer available. Select System default and try again.';
  if (item?.name === 'QuotaExceededError') return 'Device storage is full. The session was stopped safely; export the audio already captured.';
  return error instanceof Error ? error.message : 'The audio system could not start. Reload Safari and try again.';
};

export default function Home() {
  const [settings, setSettings] = useState<RecorderSettings>(INITIAL);
  const [state, setState] = useState<SessionState>('idle');
  const [message, setMessage] = useState('Ready to record');
  const [error, setError] = useState('');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [activeInputLabel, setActiveInputLabel] = useState('System default');
  const [level, setLevel] = useState(0);
  const [inputDb, setInputDb] = useState(-100);
  const [clockMs, setClockMs] = useState(0);
  const [clockModel, setClockModel] = useState({ origin: 0, pausedTotal: 0, pauseStarted: 0 });
  const [sessionView, setSessionView] = useState<StoredSession | null>(null);
  const [nextIndexView, setNextIndexView] = useState(0);
  const [logs, setLogs] = useState<string[]>([]);
  const [recoverable, setRecoverable] = useState<StoredSession[]>([]);
  const [testUrl, setTestUrl] = useState('');
  const [audioUrl, setAudioUrl] = useState('');
  const [wavFile, setWavFile] = useState<File | null>(null);
  const [exportProgress, setExportProgress] = useState(0);
  const [storageText, setStorageText] = useState('Checking…');
  const [debugMode, setDebugMode] = useState(false);
  const [secureContext, setSecureContext] = useState(true);
  const [discardingId, setDiscardingId] = useState<string | null>(null);
  const [discardMessage, setDiscardMessage] = useState('');

  const engineRef = useRef(new AudioEngine());
  const storeRef = useRef(new SessionStore());
  const settingsRef = useRef(settings);
  const stateRef = useRef<SessionState>('idle');
  const sessionRef = useRef<StoredSession | null>(null);
  const timerRef = useRef<number | null>(null);
  const originRef = useRef(0);
  const pausedTotalRef = useRef(0);
  const pauseStartedRef = useRef(0);
  const previousStateRef = useRef<SessionState>('waiting');
  const nextIndexRef = useRef(0);
  const currentRef = useRef<CaptureRecord | null>(null);
  const remainingFramesRef = useRef(0);
  const chunkSeqRef = useRef(0);
  const persistenceRef = useRef(Promise.resolve());
  const volatileChunksRef = useRef<StoredChunk[]>([]);
  const actionRef = useRef<'natural' | 'pause' | 'stop' | 'hidden'>('natural');
  const hiddenRef = useRef(false);
  const audioSuspendedRef = useRef(false);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const testChunksRef = useRef<Int16Array[]>([]);
  const audioUrlRef = useRef('');
  const testUrlRef = useRef('');
  const finalizingRef = useRef(false);

  const setMachineState = useCallback((next: SessionState) => { stateRef.current = next; setState(next); }, []);
  const log = useCallback((text: string) => {
    const line = `${new Date().toLocaleTimeString()}  ${text}`;
    setLogs((items) => [...items.slice(-199), line]);
  }, []);

  const sessionDuration = durationSeconds(settings);
  const options = phase2Settings(settings);
  const planned = scheduledCount(settings, sessionDuration);
  const elapsed = ACTIVE_STATES.includes(state) && clockModel.origin
    ? Math.max(0, (clockMs - clockModel.origin - clockModel.pausedTotal - (state === 'paused' ? clockMs - clockModel.pauseStarted : 0)) / 1000)
    : sessionView ? sessionView.captures.reduce((sum, capture) => sum + capture.frames, 0) / Math.max(1, sessionView.sampleRate) : 0;
  const capturedAudio = sessionView ? sessionView.totalFrames / Math.max(1, sessionView.sampleRate) : 0;
  const nextTarget = captureSlot(settings, nextIndexView).targetSeconds;
  const nextCountdown = state === 'waiting' ? Math.max(0, nextTarget - elapsed) : 0;

  useEffect(() => {
    const store = storeRef.current;
    void store.open().then(async () => {
      setRecoverable(await store.recoverable());
      if (navigator.storage?.estimate) {
        const estimate = await navigator.storage.estimate();
        const available = (estimate.quota ?? 0) - (estimate.usage ?? 0);
        setStorageText(available ? `${(available / 1024 / 1024 / 1024).toFixed(1)} GB estimated available` : 'Storage estimate unavailable');
      } else setStorageText('Storage estimate unavailable');
    });
    queueMicrotask(() => {
      setDebugMode(new URLSearchParams(location.search).get('debug') === '1');
      setSecureContext(window.isSecureContext || location.hostname === 'localhost');
      setClockMs(performance.now());
    });
  }, []);

  useEffect(() => { settingsRef.current = settings; }, [settings]);

  useEffect(() => {
    if (!ACTIVE_STATES.includes(state) && state !== 'ready' && state !== 'requesting-permission' && state !== 'testing') { queueMicrotask(() => setLevel(0)); return; }
    const id = window.setInterval(() => { setLevel(engineRef.current.level()); setInputDb(engineRef.current.inputDb); setClockMs(performance.now()); }, 80);
    return () => clearInterval(id);
  }, [state]);

  useEffect(() => {
    if (!ACTIVE_STATES.includes(state)) return;
    const id = window.setInterval(() => setClockMs(performance.now()), 250);
    return () => clearInterval(id);
  }, [state]);

  const persistSession = useCallback(() => {
    const session = sessionRef.current;
    if (!session?.settings.persist) return Promise.resolve();
    const snapshot = structuredClone(session);
    persistenceRef.current = persistenceRef.current.catch(() => undefined).then(() => storeRef.current.putSession(snapshot)).catch((failure) => { setError(friendlyError(failure)); log('Session metadata could not be saved'); });
    return persistenceRef.current;
  }, [log]);

  const refreshSessionView = useCallback(() => {
    const session = sessionRef.current;
    setSessionView(session ? { ...session, captures: session.captures.map((capture) => ({ ...capture })) } : null);
  }, []);

  const releaseWakeLock = useCallback(async () => {
    await wakeLockRef.current?.release().catch(() => undefined);
    wakeLockRef.current = null;
  }, []);

  const requestWakeLock = useCallback(async () => {
    if (!settings.keepAwake || !('wakeLock' in navigator)) return;
    try { wakeLockRef.current = await navigator.wakeLock.request('screen'); log('Screen wake lock acquired'); }
    catch { log('Screen wake lock was not available'); }
  }, [log, settings.keepAwake]);

  const buildExport = useCallback(async (session: StoredSession) => {
    setMachineState('processing'); setMessage('Preparing audio…'); setExportProgress(0);
    const blob = await exportWav(session, async (index) => {
      const durable = session.settings.persist ? await storeRef.current.chunksForCapture(session.id, index) : [];
      const temporary = volatileChunksRef.current.filter(c => c.sessionId === session.id && c.captureIndex === index);
      return [...durable, ...temporary].sort((a, b) => a.seq - b.seq);
    }, setExportProgress);
    const filename = `${session.name}_${filenameStamp(new Date(session.createdAt))}.wav`;
    const file = new File([blob], filename, { type: 'audio/wav', lastModified: Date.now() });
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    audioUrlRef.current = URL.createObjectURL(blob);
    setAudioUrl(audioUrlRef.current); setWavFile(file); setExportProgress(100);
    setMachineState('complete'); setMessage('Timelapse complete'); log(`Export prepared: ${(blob.size / 1024 / 1024).toFixed(1)} MB`);
  }, [log, setMachineState]);

  const finishSession = useCallback(async (reason = 'Session complete') => {
    if (finalizingRef.current) return;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    const session = sessionRef.current;
    if (!session) return;
    finalizingRef.current = true;
    engineRef.current.disarm();
    if (session.settings.recordingMode === 'sequence' && session.timelineSeconds === undefined) {
      const end = (stateRef.current === 'paused' ? pauseStartedRef.current : performance.now()) - originRef.current - pausedTotalRef.current;
      const finite = durationSeconds(session.settings);
      session.timelineSeconds = Math.max(0, Math.min(end / 1000, finite ?? Infinity));
    }
    setMachineState('stopping'); setMessage('Finalising captured audio…');
    await persistenceRef.current.catch(() => undefined);
    session.status = 'complete'; refreshSessionView();
    await persistSession().catch(() => undefined);
    await releaseWakeLock();
    await engineRef.current.destroy();
    log(reason);
    try { await buildExport(session); }
    catch (exportError) { setError(friendlyError(exportError)); setMachineState('error'); setMessage('Export failed — your session data is still preserved'); }
    finally { finalizingRef.current = false; }
  }, [buildExport, log, persistSession, refreshSessionView, releaseWakeLock, setMachineState]);

  const activeElapsedMs = useCallback(() => performance.now() - originRef.current - pausedTotalRef.current, []);

  const stopSession = useCallback(async () => {
    const previous = stateRef.current;
    if (!['recording-capture', 'waiting', 'paused', 'requesting-permission'].includes(previous)) return;
    if (timerRef.current !== null) clearTimeout(timerRef.current); timerRef.current = null;
    engineRef.current.disarm();
    const stoppingSession = sessionRef.current;
    if (stoppingSession?.settings.recordingMode === 'sequence') {
      const end = (previous === 'paused' ? pauseStartedRef.current : performance.now()) - originRef.current - pausedTotalRef.current;
      stoppingSession.timelineSeconds = Math.max(0, Math.min(end / 1000, durationSeconds(stoppingSession.settings) ?? Infinity));
    }
    setMachineState('stopping'); setMessage('Stopping safely…');
    if (previous === 'recording-capture' && currentRef.current) {
      actionRef.current = 'stop'; engineRef.current.stopCapture(); return;
    }
    if (previous === 'paused' && currentRef.current) {
      currentRef.current.outcome = 'partial'; currentRef.current.actualEndMs = activeElapsedMs();
      currentRef.current = null; refreshSessionView();
    }
    await finishSession('Stopped by user');
  }, [activeElapsedMs, finishSession, refreshSessionView, setMachineState]);

  const scheduleNextRef = useRef<() => void>(() => undefined);
  const beginCapture = useCallback((index: number, targetMs: number, frameCount?: number) => {
    const session = sessionRef.current;
    if (!session || hiddenRef.current || stateRef.current === 'stopping') return;
    const actual = activeElapsedMs();
    const finiteSeconds = durationSeconds(session.settings);
    const slot = captureSlot(session.settings, index);
    const allowedSeconds = finiteSeconds === null ? slot.seconds : Math.min(slot.seconds, Math.max(0, finiteSeconds - targetMs / 1000));
    const frames = frameCount ?? (session.settings.recordingMode === 'sequence'
      ? captureFrameBudget(session.settings, index, session.sampleRate, finiteSeconds)
      : secondsToFrames(allowedSeconds, session.sampleRate));
    if (frames <= 0) { void finishSession('Session duration reached'); return; }
    let record = currentRef.current;
    if (!record || record.index !== index) {
      record = { index, targetMs, actualStartMs: actual, actualEndMs: null, driftMs: actual - targetMs, frames: 0, expectedFrames: frames, outcome: 'recording' };
      session.captures.push(record); currentRef.current = record; refreshSessionView();
      log(`Capture ${index + 1} started (${Math.round(record.driftMs ?? 0)} ms drift)`);
    } else log(`Capture ${index + 1} resumed`);
    remainingFramesRef.current = frames;
    actionRef.current = 'natural';
    setMachineState('recording-capture'); setMessage(slot.stepIndex === null ? 'Capturing' : 'Capturing step ' + (slot.stepIndex + 1));
    engineRef.current.startCapture(index, frames);
    void persistSession();
  }, [activeElapsedMs, finishSession, log, persistSession, refreshSessionView, setMachineState]);

  const scheduleNext = useCallback(() => {
    const session = sessionRef.current;
    if (!session || currentRef.current || hiddenRef.current || stateRef.current === 'paused' || stateRef.current === 'stopping') return;
    const finite = durationSeconds(session.settings);
    if (!isScheduled(session.settings)) {
      const remaining = finite === null ? null : Math.max(0, finite - activeElapsedMs() / 1000);
      if (remaining !== null && remaining <= 0) { void finishSession('Session duration reached'); return; }
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      setMachineState('waiting'); setMessage('Listening for ' + (phase2Settings(session.settings).recordingMode === 'speech' ? 'speech' : phase2Settings(session.settings).recordingMode === 'percussive' ? 'a percussive attack' : 'the volume threshold'));
      engineRef.current.arm(session.settings, nextIndexRef.current, remaining);
      if (remaining !== null) timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (activeElapsedMs() >= finite! * 1000) void stopSession(); else scheduleNextRef.current();
      }, Math.min(30000, remaining * 1000));
      return;
    }
    let index = nextIndexRef.current;
    let targetMs = captureSlot(session.settings, index).targetSeconds * 1000;
    const elapsedMs = activeElapsedMs();
    const graceMs = Math.min(JITTER_GRACE_MS, (captureSlot(session.settings, index + 1).targetSeconds - captureSlot(session.settings, index).targetSeconds) * 250);
    if (finite !== null && targetMs >= finite * 1000) {
      const remaining = finite * 1000 - elapsedMs;
      if (remaining <= 0) { void finishSession('Scheduled duration complete'); return; }
      setMachineState('waiting'); setMessage('All captures saved — finishing session');
      timerRef.current = window.setTimeout(() => { timerRef.current = null; scheduleNextRef.current(); }, Math.min(30000, remaining));
      return;
    }

    if (index > 0 && elapsedMs - targetMs > graceMs) {
      let missed = 0;
      while (targetMs <= elapsedMs && (finite === null || targetMs < finite * 1000)) {
        session.captures.push({ index, targetMs, actualStartMs: null, actualEndMs: null, driftMs: null, frames: 0, expectedFrames: secondsToFrames(captureSlot(session.settings, index).seconds, session.sampleRate), outcome: 'missed' });
        index += 1; missed += 1; targetMs = captureSlot(session.settings, index).targetSeconds * 1000;
      }
      session.missed += missed; nextIndexRef.current = index; setNextIndexView(index); refreshSessionView();
      if (missed) { log(`${missed} scheduled capture${missed === 1 ? '' : 's'} missed`); setMessage(`${missed} capture${missed === 1 ? '' : 's'} missed while inactive`); void persistSession(); }
      if (finite !== null && targetMs >= finite * 1000) { void finishSession('Session ended while the browser was inactive'); return; }
    }

    const delay = Math.max(0, targetMs - activeElapsedMs());
    setMachineState('waiting');
    if (!message.includes('missed')) setMessage(session.settings.recordingMode === 'sequence' ? 'Waiting for step ' + ((captureSlot(session.settings, index).stepIndex ?? 0) + 1) : 'Waiting for next capture');
    if (delay > 30000) timerRef.current = window.setTimeout(() => { timerRef.current = null; scheduleNextRef.current(); }, 30000);
    else timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      if (document.hidden) return;
      const late = activeElapsedMs() - targetMs;
      if (index > 0 && late > graceMs) { scheduleNextRef.current(); return; }
      beginCapture(index, targetMs);
    }, delay);
  }, [activeElapsedMs, beginCapture, finishSession, log, message, persistSession, refreshSessionView, setMachineState, stopSession]);
  useEffect(() => { scheduleNextRef.current = scheduleNext; }, [scheduleNext]);

  const configureEngineCallbacks = useCallback(() => {
    const engine = engineRef.current;
    engine.onTriggered = (index, frames, preRollFrames) => {
      const session = sessionRef.current;
      if (!session || stateRef.current !== 'waiting' || hiddenRef.current || currentRef.current) { engine.stopCapture(); return; }
      const actual = Math.max(0, activeElapsedMs() - preRollFrames / session.sampleRate * 1000);
      const record: CaptureRecord = { index, targetMs: actual, actualStartMs: actual, actualEndMs: null, driftMs: 0, frames: 0, expectedFrames: frames, outcome: 'recording' };
      currentRef.current = record; session.captures.push(record); actionRef.current = 'natural';
      remainingFramesRef.current = frames; refreshSessionView();
      setMachineState('recording-capture'); setMessage('Capturing ' + MODE_NAMES[phase2Settings(session.settings).recordingMode].toLowerCase());
      log('Sound triggered sample ' + (index + 1) + ' (' + Math.round(preRollFrames / session.sampleRate * 1000) + ' ms pre-roll)');
    };
    engine.onSessionEnd = () => { if (['waiting', 'recording-capture'].includes(stateRef.current)) void stopSession(); };
    engine.onError = (message) => {
      setError(message); log(message);
      if (!sessionRef.current || !['waiting', 'recording-capture', 'paused'].includes(stateRef.current)) return;
      const record = currentRef.current;
      if (record) { record.outcome = 'interrupted'; record.actualEndMs = activeElapsedMs(); currentRef.current = null; refreshSessionView(); }
      engine.cancelCapture(); void finishSession('Audio processor stopped; exported the chunks already received');
    };
    engine.onChunk = (captureIndex, samples) => {
      if (captureIndex === TEST_CAPTURE_INDEX) { testChunksRef.current.push(samples); return; }
      const session = sessionRef.current;
      const record = currentRef.current;
      if (!session || !record || record.index !== captureIndex) return;
      record.frames += samples.length; session.totalFrames += samples.length; refreshSessionView();
      const samplesBuffer = samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.byteLength) as ArrayBuffer;
      const chunk: StoredChunk = { id: `${session.id}:${chunkSeqRef.current}`, sessionId: session.id, seq: chunkSeqRef.current++, captureIndex, samples: samplesBuffer };
      if (session.settings.persist) {
        persistenceRef.current = persistenceRef.current.then(() => storeRef.current.putChunk(chunk)).catch((storageError) => {
          volatileChunksRef.current.push(chunk);
          setError(friendlyError(storageError) + ' Keep this page open: the last chunk is held in memory until you save.'); log('Storage failed; retained chunk in memory and stopping safely'); void stopSession();
        });
      } else volatileChunksRef.current.push(chunk);
    };
    engine.onCaptureComplete = (captureIndex, _segmentFrames, remainingFrames) => {
      if (captureIndex === TEST_CAPTURE_INDEX) {
        const total = testChunksRef.current.reduce((sum, part) => sum + part.length, 0);
        const pcm = new Int16Array(total); let offset = 0;
        testChunksRef.current.forEach((part) => { pcm.set(part, offset); offset += part.length; });
        const blob = new Blob([wavHeader(pcm.byteLength, engine.sampleRate), pcm], { type: 'audio/wav' });
        if (testUrlRef.current) URL.revokeObjectURL(testUrlRef.current);
        testUrlRef.current = URL.createObjectURL(blob); testChunksRef.current = [];
        void engine.destroy();
        setTestUrl(testUrlRef.current); setMachineState('ready'); setMessage('Microphone test complete — play it back below'); log('Microphone test captured 2 seconds');
        return;
      }
      const session = sessionRef.current; const record = currentRef.current;
      if (!session || !record || record.index !== captureIndex) { log(`Ignored stale capture completion for ${captureIndex + 1}`); return; }
      remainingFramesRef.current = remainingFrames;
      if (actionRef.current === 'pause') {
        if (remainingFrames === 0) { record.actualEndMs = activeElapsedMs(); record.outcome = 'completed'; currentRef.current = null; nextIndexRef.current = captureIndex + 1; setNextIndexView(captureIndex + 1); refreshSessionView(); void persistSession(); }
        setMachineState('paused'); setMessage('Paused'); return;
      }
      record.actualEndMs = activeElapsedMs();
      record.outcome = actionRef.current === 'hidden' ? 'interrupted' : remainingFrames > 0 ? 'partial' : 'completed';
      log(`Capture ${captureIndex + 1} ${record.outcome} (${record.frames} frames)`);
      currentRef.current = null; nextIndexRef.current = captureIndex + 1; setNextIndexView(captureIndex + 1); refreshSessionView();
      void persistSession();
      if (actionRef.current === 'stop') void finishSession('Stopped by user');
      else if (!hiddenRef.current) scheduleNextRef.current();
    };
    engine.onInputEvent = (event) => {
      if (event === 'muted') { setMessage('Microphone muted — check Bluetooth connection'); log('Microphone input muted'); }
      if (event === 'unmuted') { setMessage('Microphone input restored'); log('Microphone input restored'); }
      if (event === 'ended') { setError('The active microphone disconnected. The audio already captured is safe.'); log('Microphone stream ended'); void stopSession(); }
      if (event === 'context-suspended') {
        log('Audio context suspended');
        if (sessionRef.current && ['waiting', 'recording-capture'].includes(stateRef.current)) {
          if (timerRef.current !== null) clearTimeout(timerRef.current); timerRef.current = null;
          const record = currentRef.current;
          if (record) {
            record.actualEndMs = activeElapsedMs(); record.outcome = 'interrupted';
            currentRef.current = null; nextIndexRef.current = record.index + 1; setNextIndexView(record.index + 1);
            engine.cancelCapture(); refreshSessionView(); void persistSession();
          }
          engine.disarm();
          pauseStartedRef.current = performance.now(); setClockModel(model => ({ ...model, pauseStarted: pauseStartedRef.current }));
          audioSuspendedRef.current = true; setMachineState('paused'); setMessage('Audio suspended — tap Resume to continue');
        }
      }
    };
  }, [activeElapsedMs, finishSession, log, persistSession, refreshSessionView, setMachineState, stopSession]);

  const initialiseAudio = useCallback(async (synthetic = false) => {
    setMachineState('requesting-permission'); setMessage(synthetic ? 'Starting test tone…' : 'Waiting for microphone permission…'); setError('');
    configureEngineCallbacks();
    await engineRef.current.initialize(settings.deviceId, synthetic);
    configureEngineCallbacks();
    setDevices(await engineRef.current.inputs()); setActiveInputLabel(engineRef.current.activeDeviceLabel);
    log(`Audio ready: ${engineRef.current.activeDeviceLabel}, ${engineRef.current.sampleRate} Hz mono`);
  }, [configureEngineCallbacks, log, setMachineState, settings.deviceId]);

  const testMicrophone = useCallback(async () => {
    if (!['idle', 'ready', 'error'].includes(stateRef.current)) return;
    try {
      testChunksRef.current = [];
      await initialiseAudio(debugMode);
      setMachineState('testing'); setMessage('Testing microphone for 2 seconds…');
      engineRef.current.startCapture(TEST_CAPTURE_INDEX, secondsToFrames(2, engineRef.current.sampleRate));
    } catch (testError) { setError(friendlyError(testError)); setMachineState('error'); setMessage('Microphone test could not start'); }
  }, [debugMode, initialiseAudio, setMachineState]);

  const startSession = useCallback(async () => {
    if (!['idle', 'ready', 'complete', 'error'].includes(stateRef.current)) return;
    const validation = validateSettings(settings);
    if (validation) { setError(validation); return; }
    setDiscardMessage('');
    if (testUrlRef.current) { URL.revokeObjectURL(testUrlRef.current); testUrlRef.current = ''; setTestUrl(''); }
    if (audioUrlRef.current) { URL.revokeObjectURL(audioUrlRef.current); audioUrlRef.current = ''; setAudioUrl(''); setWavFile(null); }
    try {
      await initialiseAudio(debugMode);
      if (options.recordingMode === 'speech') { setMessage('Preparing speech detection…'); await engineRef.current.prepareSpeech(options.speechMode); }
      await requestWakeLock();
      const now = new Date();
      const session: StoredSession = {
        id: crypto.randomUUID(), name: 'Longland_Timelapse', createdAt: now.toISOString(), updatedAt: now.toISOString(), status: 'active',
        settings: { ...settings }, sampleRate: engineRef.current.sampleRate, captures: [], missed: 0, totalFrames: 0, browser: navigator.userAgent,
      };
      sessionRef.current = session; volatileChunksRef.current = []; chunkSeqRef.current = 0; currentRef.current = null;
      nextIndexRef.current = 0; setNextIndexView(0); pausedTotalRef.current = 0; originRef.current = performance.now(); hiddenRef.current = document.hidden; audioSuspendedRef.current = false; finalizingRef.current = false;
      persistenceRef.current = Promise.resolve();
      setClockModel({ origin: originRef.current, pausedTotal: 0, pauseStarted: 0 }); setClockMs(originRef.current);
      setSessionView({ ...session, captures: [] }); setLogs([]); log(`Session started with ${engineRef.current.activeDeviceLabel}`);
      if (settings.persist) await storeRef.current.putSession(session);
      setError('');
      setMachineState('waiting');
      if (options.recordingMode === 'timed') beginCapture(0, 0); else scheduleNextRef.current();
    } catch (startError) { setError(friendlyError(startError)); setMachineState('error'); setMessage('Recording could not start'); await engineRef.current.destroy(); await releaseWakeLock(); }
  }, [beginCapture, debugMode, initialiseAudio, log, releaseWakeLock, requestWakeLock, setMachineState, settings, options.recordingMode, options.speechMode]);

  const pauseSession = useCallback(() => {
    if (!['recording-capture', 'waiting'].includes(stateRef.current)) return;
    engineRef.current.disarm();
    previousStateRef.current = stateRef.current;
    pauseStartedRef.current = performance.now();
    setClockModel((model) => ({ ...model, pauseStarted: pauseStartedRef.current }));
    if (timerRef.current !== null) clearTimeout(timerRef.current); timerRef.current = null;
    if (stateRef.current === 'recording-capture') { actionRef.current = 'pause'; engineRef.current.stopCapture(); }
    else { setMachineState('paused'); setMessage('Paused'); }
    log('Session paused');
  }, [log, setMachineState]);

  const resumeSession = useCallback(async () => {
    if (stateRef.current !== 'paused') return;
    if (audioSuspendedRef.current) {
      try {
        await engineRef.current.resume(); audioSuspendedRef.current = false;
        setMachineState('waiting'); setMessage('Audio restored — checking schedule'); log('Audio context resumed'); scheduleNextRef.current();
      } catch (resumeError) { setError(friendlyError(resumeError)); }
      return;
    }
    try { await engineRef.current.resume(); } catch (resumeError) { setError(friendlyError(resumeError)); return; }
    pausedTotalRef.current += performance.now() - pauseStartedRef.current;
    setClockModel((model) => ({ ...model, pausedTotal: pausedTotalRef.current }));
    log('Session resumed');
    if (currentRef.current && remainingFramesRef.current > 0) beginCapture(currentRef.current.index, currentRef.current.targetMs, remainingFramesRef.current);
    else { setMachineState('waiting'); scheduleNextRef.current(); }
  }, [beginCapture, log, setMachineState]);

  useEffect(() => {
    const onVisibility = () => {
      if (!sessionRef.current || !ACTIVE_STATES.includes(stateRef.current)) return;
      if (document.hidden) {
        engineRef.current.disarm();
        hiddenRef.current = true; if (timerRef.current !== null) clearTimeout(timerRef.current); timerRef.current = null;
        log('Page hidden — Safari may suspend recording');
        if (stateRef.current === 'recording-capture') { actionRef.current = 'hidden'; engineRef.current.stopCapture(); }
      } else {
        hiddenRef.current = false; log('Page visible — checking schedule');
        void requestWakeLock();
        if (stateRef.current === 'paused') return;
        if (engineRef.current.context && engineRef.current.context.state !== 'running') {
          audioSuspendedRef.current = true; pauseStartedRef.current = performance.now(); setClockModel(model => ({ ...model, pauseStarted: pauseStartedRef.current })); setMachineState('paused'); setMessage('Audio suspended — tap Resume to continue'); return;
        }
        if (!currentRef.current) window.setTimeout(() => scheduleNextRef.current(), 0);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [log, requestWakeLock, setMachineState]);

  useEffect(() => {
    const context = (document as Document & { modelContext?: { registerTool?: (tool: unknown, options?: { signal?: AbortSignal }) => void | Promise<void> } }).modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    const tool = {
      name: 'configure_longland_timelapse', title: 'Configure Longland Timelapse',
      description: 'Set capture length, start-to-start interval, and finite session duration. This stages settings but never starts the microphone.',
      inputSchema: { type: 'object', properties: { captureSeconds: { type: 'number', minimum: 0.01, maximum: 5 }, intervalSeconds: { type: 'number', minimum: 0.01 }, durationMinutes: { type: 'number', exclusiveMinimum: 0 } }, required: ['captureSeconds', 'intervalSeconds', 'durationMinutes'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute(input: unknown) {
        if (!['idle', 'ready', 'error'].includes(stateRef.current)) throw new Error('Stop the current recording or microphone test before changing settings.');
        const value = input as { captureSeconds: number; intervalSeconds: number; durationMinutes: number };
        const candidate = { ...settingsRef.current, captureSeconds: value.captureSeconds, intervalSeconds: value.intervalSeconds, durationValue: value.durationMinutes, durationUnit: 'minutes' as const, manualStop: false };
        const validation = validateSettings(candidate); if (validation) throw new Error(validation);
        setSettings(candidate); return { configured: true, ...value, note: 'A person must tap Start to grant microphone access.' };
      },
    };
    try { void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(() => undefined); } catch { /* optional browser capability */ }
    return () => lifecycle.abort();
  }, []);

  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    void engineRef.current.destroy(); void releaseWakeLock();
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current); if (testUrlRef.current) URL.revokeObjectURL(testUrlRef.current);
  }, [releaseWakeLock]);

  const share = async () => {
    if (!wavFile) return;
    try {
      if (navigator.share && (!navigator.canShare || navigator.canShare({ files: [wavFile] }))) await navigator.share({ files: [wavFile], title: 'Longland Timelapse' });
      else setError('File sharing is not available here. Use Save audio instead.');
    } catch (shareError) { if ((shareError as DOMException).name !== 'AbortError') setError(friendlyError(shareError)); }
  };

  const exportJson = () => {
    const session = sessionRef.current; if (!session) return;
    const summary = { ...session, audioDurationSeconds: session.totalFrames / session.sampleRate, activeDevice: engineRef.current.activeDeviceLabel };
    const url = URL.createObjectURL(new Blob([JSON.stringify(summary, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `Longland_Session_${filenameStamp(new Date(session.createdAt))}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const copyDiagnostics = async () => {
    const text = [`Longland Timelapse`, `State: ${stateRef.current}`, `Browser: ${navigator.userAgent}`, `Secure context: ${window.isSecureContext}`, `Audio: ${engineRef.current.sampleRate} Hz / ${engineRef.current.activeDeviceLabel}`, '', ...logs].join('\n');
    try { await navigator.clipboard.writeText(text); setMessage('Diagnostics copied'); }
    catch { setError('Could not copy diagnostics. Select the event log text manually.'); }
  };

  const finaliseRecovered = async (session: StoredSession) => {
    const frameSummary = await storeRef.current.summarizeChunks(session.id);
    const captures = session.captures.map((capture) => ({ ...capture, frames: frameSummary.get(capture.index) ?? 0 }));
    for (const [captureIndex, frames] of frameSummary) {
      let capture = captures.find((item) => item.index === captureIndex);
      if (!capture) {
        capture = { index: captureIndex, targetMs: captureSlot(session.settings, captureIndex).targetSeconds * 1000, actualStartMs: null, actualEndMs: null, driftMs: null, frames, expectedFrames: secondsToFrames(captureSlot(session.settings, captureIndex).seconds, session.sampleRate), outcome: 'partial' };
        captures.push(capture);
      } else {
        capture.frames = frames;
        if (capture.outcome === 'recording') capture.outcome = 'partial';
      }
    }
    captures.sort((a, b) => a.index - b.index);
    const recovered = { ...session, status: 'complete' as const, captures, totalFrames: [...frameSummary.values()].reduce((sum, frames) => sum + frames, 0) };
    sessionRef.current = recovered; setSessionView(recovered); setSettings(recovered.settings); log(`Recovered session from ${new Date(recovered.createdAt).toLocaleString()}`);
    try { await storeRef.current.putSession(recovered); await buildExport(recovered); }
    catch (recoveryError) { setError(friendlyError(recoveryError)); setMachineState('error'); }
  };

  const discardRecovered = async (session: StoredSession) => {
    if (discardingId) return;
    setDiscardingId(session.id); setError('');
    try {
      await storeRef.current.deleteSession(session.id);
      const remaining = await storeRef.current.recoverable(); setRecoverable(remaining);
      setDiscardMessage(`Recording discarded. ${remaining.length ? `${remaining.length} other saved recording${remaining.length === 1 ? '' : 's'} remain.` : 'No saved recordings remain.'}`);
      log('Previous session discarded by user'); setMessage('Audio discarded');
    } catch (failure) { setError('Could not discard this recording. ' + friendlyError(failure)); }
    finally { setDiscardingId(null); }
  };

  const newSession = async () => {
    const session = sessionRef.current;
    // New session keeps saved audio recoverable until the user explicitly discards it.
    if (session?.settings.persist) setRecoverable(await storeRef.current.recoverable());
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current); audioUrlRef.current = '';
    sessionRef.current = null; setSessionView(null); volatileChunksRef.current = []; setAudioUrl(''); setWavFile(null); setError(''); setMessage('Ready to record'); setMachineState('idle'); setLogs([]);
  };

  const applyFades = async (draft: RecorderSettings, overrides: Record<number, FadeSettings>) => {
    const session = sessionRef.current; if (!session || stateRef.current !== 'complete') return;
    const candidate = { ...session.settings, fadeInMs: draft.fadeInMs, fadeOutMs: draft.fadeOutMs, fadeCurve: draft.fadeCurve, fadeLinked: draft.fadeLinked };
    const invalid = validateSettings(candidate) ?? Object.values(overrides).map(f => validateSettings({ ...candidate, ...f })).find(Boolean);
    if (invalid) { setError(invalid); return; }
    session.settings = candidate; session.fadeOverrides = overrides; setSettings(candidate); refreshSessionView(); setError('');
    try { await persistSession(); await buildExport(session); }
    catch (failure) { setError(friendlyError(failure)); setMachineState('complete'); }
  };

  const progress = sessionDuration ? Math.min(100, (elapsed / sessionDuration) * 100) : 0;
  const captureCount = sessionView?.captures.filter((capture) => capture.frames > 0 && capture.outcome !== 'recording').length ?? 0;
  const controlsLocked = ACTIVE_STATES.includes(state) || state === 'requesting-permission' || state === 'testing' || state === 'processing';

  return (
    <main className="min-h-dvh bg-background px-4 pb-28 pt-[max(1.25rem,env(safe-area-inset-top))] text-foreground sm:px-8">
      <div className="mx-auto max-w-5xl">
        <header className="mb-7 flex items-center justify-between border-b border-border pb-5">
          <div className="flex items-center gap-3"><span className="flex size-11 items-center justify-center rounded-full bg-foreground text-background"><Radio className="size-5" /></span><div><p className="eyebrow">FIELD RECORDER</p><h1 className="text-xl font-semibold tracking-[-0.03em]">Longland Timelapse</h1></div></div>
          <span className={`status-pill ${state === 'recording-capture' ? 'is-live' : ''}`}><i /> {state === 'recording-capture' ? 'Capturing' : state === 'complete' ? 'Complete' : state === 'paused' ? 'Paused' : state === 'waiting' ? (isScheduled(settings) ? 'Waiting' : 'Listening') : state === 'testing' ? 'Testing' : state === 'processing' ? 'Processing' : state === 'requesting-permission' ? 'Starting' : state === 'stopping' ? 'Stopping' : 'Ready'}</span>
        </header>

        {!secureContext && <Notice tone="danger">Microphone access requires HTTPS. Deploy this folder to Netlify or another HTTPS host.</Notice>}
        <Notice><strong>Keep Safari open and the screen awake.</strong> iOS may suspend browser recording when the screen locks or another app is opened.</Notice>
        {error && <Notice tone="danger"><strong>Action needed:</strong> {error}</Notice>}
        {discardMessage && state === 'idle' && <output className="mb-4 block rounded-xl border border-border bg-card p-4 text-sm">{discardMessage}</output>}
        {debugMode && <p className="debug-note mb-4">Debug audio is active. These tests use a generated tone, pulses or a speech fixture, not the microphone.</p>}

        {recoverable.length > 0 && state === 'idle' && <section className="recovery-card"><div><p className="eyebrow">RECOVERY</p><h2>Previous audio is available</h2><p>Most recent of {recoverable.length} saved recording{recoverable.length === 1 ? '' : 's'}</p><p>{new Date(recoverable[0].createdAt).toLocaleString()} · {formatClock(recoverable[0].totalFrames / recoverable[0].sampleRate)} captured</p></div><div className="flex flex-wrap gap-2"><Button className="h-11" disabled={!!discardingId} onClick={() => finaliseRecovered(recoverable[0])}>Finalise audio</Button><Button className="h-11" variant="outline" disabled={!!discardingId} onClick={() => discardRecovered(recoverable[0])}>{discardingId ? 'Discarding…' : 'Discard'}</Button></div></section>}

        {state === 'complete' ? (
          <><CompletePanel session={sessionView} audioUrl={audioUrl} progress={exportProgress} onShare={share} onJson={exportJson} onNew={newSession} wavFile={wavFile} />{sessionView && <FadeEditor session={sessionView} onApply={applyFades} />}</>
        ) : ACTIVE_STATES.includes(state) || state === 'processing' ? (
          <ActivePanel inputDb={inputDb} mode={options.recordingMode} state={state} message={message} level={level} elapsed={elapsed} duration={sessionDuration} countdown={nextCountdown} captured={capturedAudio} captureCount={captureCount} planned={planned} progress={state === 'processing' ? exportProgress : progress} onPause={pauseSession} onResume={resumeSession} onStop={stopSession} />
        ) : (
          <SetupPanel settings={settings} setSettings={setSettings} devices={devices} level={level} testUrl={testUrl} state={state} disabled={controlsLocked} onTest={testMicrophone} storageText={storageText} debugMode={debugMode} />
        )}

        {(state === 'testing' || ACTIVE_STATES.includes(state)) && <p className="mt-3 text-sm text-muted-foreground">Input: {activeInputLabel} · {inputDb <= -99 ? 'below −99' : inputDb.toFixed(0)} dBFS</p>}
        <Accordion className="mt-5 panel px-5" defaultValue={[]}>
          <AccordionItem value="diagnostics" className="border-0"><AccordionTrigger className="min-h-12 no-underline hover:no-underline"><span><span className="font-semibold">Event log & diagnostics</span><span className="ml-2 text-muted-foreground">{logs.length} events</span></span></AccordionTrigger><AccordionContent><div className="log" role="log" aria-live="polite">{logs.length ? logs.map((item, index) => <div key={`${item}-${index}`}>{item}</div>) : <div>No events yet.</div>}</div><Button variant="outline" className="mt-3 h-11" onClick={copyDiagnostics}><Clipboard /> Copy diagnostics</Button></AccordionContent></AccordionItem>
        </Accordion>

        {!ACTIVE_STATES.includes(state) && state !== 'processing' && state !== 'complete' && <div className="sticky-action"><Button variant="outline" className="h-14 flex-1 text-base" onClick={testMicrophone} disabled={controlsLocked}><Headphones /> Test microphone</Button><Button className="h-14 flex-[1.4] bg-signal text-base font-semibold text-ink hover:bg-signal/90" onClick={startSession} disabled={controlsLocked}><Mic2 /> Start timelapse</Button></div>}
      </div>
    </main>
  );
}

function SetupPanel({ settings, setSettings, devices, level, testUrl, state, disabled, onTest, storageText, debugMode }: { settings: RecorderSettings; setSettings: Dispatch<SetStateAction<RecorderSettings>>; devices: MediaDeviceInfo[]; level: number; testUrl: string; state: SessionState; disabled: boolean; onTest: () => void; storageText: string; debugMode: boolean }) {
  const update = <K extends keyof RecorderSettings>(key: K, value: RecorderSettings[K]) => setSettings((current) => ({ ...current, [key]: value }));
  const validation = validateSettings(settings);
  const options = phase2Settings(settings);
  return <>
    <RecordingModeControls settings={settings} setSettings={setSettings} disabled={disabled} />
    {options.recordingMode === 'sequence' && <SequenceControls settings={settings} setSettings={setSettings} disabled={disabled} />}
    <section className="grid gap-5">
      <div className="panel p-5 sm:p-7"><div className="mb-6 flex items-start justify-between gap-4"><h2 className="eyebrow">SESSION SETUP</h2><Mic2 className="size-6 text-signal" /></div>
        {options.recordingMode !== 'sequence' && <div className="setting-row"><div><label htmlFor="capture">Capture</label><p>Any length from 0.01 to 5.00 seconds</p></div><div className="input-unit"><NumberInput id="capture" inputMode="decimal" min="0.01" max="5" step="0.01" value={settings.captureSeconds} disabled={disabled} onValueChange={(value) => update('captureSeconds', value)} /><span>seconds</span></div></div>}
        {options.recordingMode === 'timed' && <div className="setting-row"><div><label htmlFor="interval">Every</label><p>Time between the start of each capture</p></div><div className="input-unit"><NumberInput id="interval" inputMode="decimal" min="0.01" step="0.01" value={settings.intervalSeconds} disabled={disabled} onValueChange={(value) => update('intervalSeconds', value)} /><span>seconds</span></div></div>}
        <div className="setting-row border-b-0"><div><label htmlFor="duration">For</label><p>Total real-world session length</p></div><div className="flex flex-wrap justify-end gap-2"><NumberInput id="duration" className="h-12 w-24 font-mono text-lg" inputMode="decimal" min="0.01" step="0.25" value={settings.durationValue} disabled={disabled || settings.manualStop} onValueChange={(value) => update('durationValue', value)} /><NativeSelect aria-label="Duration unit" className="w-28 [&_select]:h-12" value={settings.durationUnit} disabled={disabled || settings.manualStop} onChange={(e) => update('durationUnit', e.target.value as RecorderSettings['durationUnit'])}><NativeSelectOption value="seconds">seconds</NativeSelectOption><NativeSelectOption value="minutes">minutes</NativeSelectOption><NativeSelectOption value="hours">hours</NativeSelectOption></NativeSelect><div className="check-label"><Checkbox aria-label="Record until manually stopped" disabled={disabled} checked={settings.manualStop} onCheckedChange={(checked) => update('manualStop', checked === true)} /> Until stopped</div></div></div>
        {validation && <p className="validation"><AlertTriangle /> {validation}</p>}
      </div>
    </section>
    <section className="mt-5 grid gap-5 sm:grid-cols-2"><div className="panel flex items-center gap-4 p-5"><Bluetooth className="size-6 text-signal" /><div><h3 className="font-semibold">AirPods & Bluetooth earpieces</h3><p className="mt-1 text-sm text-muted-foreground">iOS controls routing. Test first and confirm the active input below.</p></div></div><div className="panel flex items-center gap-4 p-5"><ShieldCheck className="size-6 text-signal" /><div><h3 className="font-semibold">Stays on this device</h3><p className="mt-1 text-sm text-muted-foreground">No account, upload, analytics, or cloud audio.</p></div></div></section>
    <section className="mt-5 panel p-5 sm:p-7"><div className="mb-4 flex items-center justify-between"><div><p className="eyebrow">MICROPHONE PREFLIGHT</p><h2 className="mt-1 text-lg font-semibold">{state === 'recording-capture' ? 'Listening…' : 'Verify before a long session'}</h2></div><Button variant="outline" className="h-11" onClick={onTest} disabled={disabled}><Headphones /> {state === 'testing' ? 'Testing…' : 'Test 2 seconds'}</Button></div><LevelMeter value={level} /><div className="mt-4 grid gap-4 sm:grid-cols-2"><div><span className="field-label">Audio input</span><NativeSelect aria-label="Audio input" className="mt-2 w-full [&_select]:h-12" value={settings.deviceId} disabled={disabled} onChange={(e) => update('deviceId', e.target.value)}><NativeSelectOption value="">System default</NativeSelectOption>{devices.map((device, index) => <NativeSelectOption key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</NativeSelectOption>)}</NativeSelect><small className="field-help">Device names appear after permission. Bluetooth bandwidth and routing are controlled by iOS.</small></div><div><span className="field-label">Input status</span><div className="device-readout"><i className={level > .01 ? 'live' : ''} /> {devices.length ? `${devices.length} input${devices.length === 1 ? '' : 's'} available` : 'Tap Test microphone to identify inputs'}</div><small className="field-help">{testUrl ? 'Test captured. Play it to confirm the chosen mic.' : 'Speak during the test and watch the level meter.'}</small></div></div>{testUrl && <audio aria-label="Microphone test recording" className="mt-4 w-full" controls src={testUrl}><track kind="captions" src="/empty.vtt" srcLang="en" label="No transcription" /></audio>}</section>
    <section className="panel mt-5 p-5 sm:p-7"><h2 className="mb-4 text-lg font-semibold">Sample fades</h2><FadeControls value={settings} clipSeconds={options.recordingMode === 'sequence' ? Math.max(0, ...(settings.sequence?.steps.filter(s => s.enabled).map(s => s.captureSeconds) ?? [1])) : settings.captureSeconds} disabled={disabled} onChange={value => setSettings(s => ({ ...s, ...value }))} /></section>
    <Accordion className="mt-5 panel px-5">{options.recordingMode !== 'sequence' && <AccordionItem value="output"><AccordionTrigger className="min-h-14 text-base no-underline hover:no-underline">Output settings</AccordionTrigger><AccordionContent><div className="settings-grid"><div><span className="field-label">Transition</span><NativeSelect aria-label="Transition" className="mt-2 w-full [&_select]:h-12" value={settings.transitionMs} onChange={(e) => update('transitionMs', Number(e.target.value))}>{[0,5,10,25,50,100].map((value) => <NativeSelectOption key={value} value={value}>{value === 0 ? 'Hard cut' : `${value} ms`}</NativeSelectOption>)}</NativeSelect></div><div><span className="field-label">Space between captures</span><NativeSelect aria-label="Space between captures" className="mt-2 w-full [&_select]:h-12" value={settings.gapMs} onChange={(e) => update('gapMs', Number(e.target.value))}>{[0,50,100,250,500,1000].map((value) => <NativeSelectOption key={value} value={value}>{value === 0 ? 'None' : `${value} ms`}</NativeSelectOption>)}</NativeSelect></div></div></AccordionContent></AccordionItem>}<AccordionItem value="safety"><AccordionTrigger className="min-h-14 text-base no-underline hover:no-underline">Storage & advanced</AccordionTrigger><AccordionContent><div className="space-y-4 pb-2"><div className="check-label"><Checkbox aria-label="Keep screen awake when supported" checked={settings.keepAwake} onCheckedChange={(checked) => update('keepAwake', checked === true)} /> Keep screen awake when supported</div><div className="check-label"><Checkbox aria-label="Save chunks for recovery with IndexedDB" checked={settings.persist} onCheckedChange={(checked) => update('persist', checked === true)} /> Save chunks for recovery with IndexedDB</div><p className="text-sm text-muted-foreground">{storageText}. Recording format: mono PCM16 WAV at the device&apos;s actual sample rate.</p>{debugMode && <p className="debug-note">Debug mode is active: the microphone is replaced with a synthetic 440 Hz test tone.</p>}</div></AccordionContent></AccordionItem></Accordion>
  </>;
}

function ActivePanel({ inputDb, mode, state, message, level, elapsed, duration, countdown, captured, captureCount, planned, progress, onPause, onResume, onStop }: { inputDb: number; mode: NonNullable<RecorderSettings['recordingMode']>; state: SessionState; message: string; level: number; elapsed: number; duration: number | null; countdown: number; captured: number; captureCount: number; planned: number | null; progress: number; onPause: () => void; onResume: () => void; onStop: () => void }) {
  return <section className="active-console"><div className="live-header"><span className={`live-orb ${state === 'recording-capture' ? 'pulse' : ''}`} /><div><p className="eyebrow text-white/45">TIMELAPSE ACTIVE</p><h2>{message}</h2></div></div><LevelMeter value={level} dark /><p className="mt-2 text-sm text-white/60">{inputDb <= -99 ? 'Quiet' : `${inputDb.toFixed(0)} dBFS`} input</p><div className="active-metrics"><Metric value={state === 'recording-capture' ? 'LIVE' : isScheduled({ recordingMode: mode }) ? formatClock(countdown) : 'ARMED'} label={state === 'recording-capture' ? `capture ${captureCount + 1}${planned ? ` / ${planned}` : ''}` : isScheduled({ recordingMode: mode }) ? 'next capture' : MODE_NAMES[mode]} /><Metric value={formatClock(elapsed)} label={duration === null ? 'session elapsed' : `of ${formatClock(duration)}`} /><Metric value={formatAudio(captured)} label="captured audio" /><Metric value={String(captureCount)} label="captures saved" /></div><Progress value={progress} className="mt-8 [&_[data-slot=progress-track]]:h-2 [&_[data-slot=progress-track]]:bg-white/10 [&_[data-slot=progress-indicator]]:bg-signal" /><Timeline progress={progress} /><div className="mt-8 flex gap-3">{state === 'paused' ? <Button className="h-14 flex-1 bg-signal text-ink hover:bg-signal/90" onClick={onResume}><Play /> Resume</Button> : <Button className="h-14 flex-1 bg-white/10 text-white hover:bg-white/20" onClick={onPause} disabled={state === 'stopping' || state === 'processing'}><Pause /> Pause</Button>}<Button className="h-14 flex-1 bg-white text-ink hover:bg-white/90" onClick={onStop} disabled={state === 'stopping' || state === 'processing'}><CircleStop /> Stop</Button></div></section>;
}

function CompletePanel({ session, audioUrl, progress, onShare, onJson, onNew, wavFile }: { session: StoredSession | null; audioUrl: string; progress: number; onShare: () => void; onJson: () => void; onNew: () => void; wavFile: File | null }) {
  const completed = session?.captures.filter((capture) => capture.frames > 0).length ?? 0;
  return <section className="complete-card">{session?.settings.recordingMode === 'sequence' && <p className="mb-4 text-sm text-muted-foreground">Sequence playback preserves rests and loops the whole recording. Use the player to pause.</p>}<span className="complete-icon"><Check /></span><h2 className="eyebrow">TIMELAPSE COMPLETE</h2><div className="complete-stats"><Metric value={String(completed)} label="captures" /><Metric value={formatAudio(session ? session.totalFrames / session.sampleRate : 0)} label="recorded audio" /><Metric value={session ? String(session.missed) : '0'} label="missed" /></div>{audioUrl ? <audio aria-label="Completed timelapse audio" className="my-7 w-full" controls loop={session?.settings.recordingMode === 'sequence'} src={audioUrl}><track kind="captions" src="/empty.vtt" srcLang="en" label="No transcription" /></audio> : <Progress value={progress} className="my-7" />}<div className="grid gap-3 sm:grid-cols-2"><Button className="h-14 bg-ink text-white hover:bg-ink/85" disabled={!wavFile} onClick={onShare}><Share2 /> Share</Button>{audioUrl && <a className="save-link" href={audioUrl} download={wavFile?.name}><Download /> Save audio</a>}<Button variant="outline" className="h-12" onClick={onJson}><FileJson /> Session data</Button><Button variant="outline" className="h-12" onClick={onNew}><RotateCcw /> New session</Button></div></section>;
}

function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'danger' }) { return <div className={`notice ${tone}`}><AlertTriangle /> <div>{children}</div></div>; }
function Metric({ value, label }: { value: string; label: string }) { return <div><strong className="font-mono text-2xl tracking-[-0.04em] sm:text-3xl">{value}</strong><p className="mt-1 text-xs uppercase tracking-[.12em] opacity-50">{label}</p></div>; }
function LevelMeter({ value, dark = false }: { value: number; dark?: boolean }) { return <><div className={`meter ${dark ? 'dark' : ''}`} aria-hidden="true"><i style={{ transform: `scaleX(${Math.max(.008, value)})` }} /></div><meter className="sr-only" aria-label="Microphone input level" min={0} max={100} value={Math.round(value * 100)} /></>; }
function Timeline({ progress }: { progress: number }) { const canvas = useRef<HTMLCanvasElement>(null); useEffect(() => { const node = canvas.current; if (!node) return; const ratio = devicePixelRatio || 1; const width = node.clientWidth; const height = node.clientHeight; node.width = width * ratio; node.height = height * ratio; const ctx = node.getContext('2d'); if (!ctx) return; ctx.scale(ratio, ratio); ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(0, height / 2 - 1, width, 2); const steps = 80; for (let i = 0; i < steps; i += 1) { const x = i / (steps - 1) * width; ctx.fillStyle = i / (steps - 1) * 100 <= progress ? '#b9f227' : 'rgba(255,255,255,.15)'; ctx.fillRect(x, height / 2 - (i % 5 === 0 ? 8 : 3), 2, i % 5 === 0 ? 16 : 6); } }, [progress]); return <canvas ref={canvas} className="mt-5 h-8 w-full" aria-label={`Session timeline ${Math.round(progress)} percent complete`} />; }
