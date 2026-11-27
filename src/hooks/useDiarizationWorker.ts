import { useState, useRef, useCallback } from 'react';
import type {
  WordChunk,
  SpeakerSegment,
  SpeakerLine,
  DiarizationStage,
  DiarizationWorkerMessage,
  DiarizationWorkerResponse
} from '@/types/diarization';
import type { AudioProgress, LoadingProgress } from '@/types/whisper';

export const useDiarizationWorker = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [device, setDevice] = useState<'webgpu' | 'wasm' | null>(null);
  const [words, setWords] = useState<WordChunk[]>([]);              // live, before speakers are known
  const [segments, setSegments] = useState<SpeakerSegment[]>([]);   // pyannote's speaker turns
  const [lines, setLines] = useState<SpeakerLine[]>([]);            // final merged result
  const [loadingProgress, setLoadingProgress] = useState<LoadingProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<(AudioProgress & { stage: DiarizationStage }) | null>(null);

  const workerRef = useRef<Worker | null>(null);
  const resolveRef = useRef<((lines: SpeakerLine[]) => void) | null>(null);
  const rejectRef = useRef<((e: Error) => void) | null>(null);

  // The worker is only created the first time it's needed,
  // so nothing heavy happens while "Identify speakers" is off.
  const getWorker = useCallback((): Worker => {
    if (workerRef.current) return workerRef.current;

    const worker = new Worker(new URL('../workers/diarization-worker.ts', import.meta.url), { type: 'module' });

    worker.onmessage = (event: MessageEvent<DiarizationWorkerResponse>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'loading':
          // Also when Transcribe started the loading: the screen shows "Loading speaker models" instead of "0 words"
          setIsLoading(true);
          setLoadingProgress({ status: msg.status, progress: msg.progress, file: msg.file });
          break;
        case 'ready':
          setIsLoading(false);
          setIsReady(true);
          setDevice(msg.device);
          setLoadingProgress(null);
          break;
        case 'progress':
          setProgress({ stage: msg.stage, done: msg.done, total: msg.total });
          break;
        case 'partial':
          setWords(prev => [...prev, ...msg.words]);
          break;
        case 'segments':
          setSegments(msg.segments);
          break;
        case 'complete':
          setLines(msg.lines);
          setIsTranscribing(false);
          setProgress(null);
          resolveRef.current?.(msg.lines);
          resolveRef.current = null;
          rejectRef.current = null;
          break;
        case 'error':
          setIsLoading(false);
          setIsTranscribing(false);
          setProgress(null);
          setError(msg.error);
          rejectRef.current?.(new Error(msg.error));
          resolveRef.current = null;
          rejectRef.current = null;
          break;
      }
    };

    worker.onerror = (event) => {
      const message = `Diarization worker error: ${event.message}`;
      setIsLoading(false);
      setIsTranscribing(false);
      setProgress(null);
      setError(message);
      rejectRef.current?.(new Error(message));
      resolveRef.current = null;
      rejectRef.current = null;
    };

    workerRef.current = worker;
    return worker;
  }, []);

  const loadModels = useCallback(() => {
    setIsLoading(true);
    setError(null);
    const message: DiarizationWorkerMessage = { type: 'load' };
    getWorker().postMessage(message); // if already loaded, the worker replies 'ready' straight away
  }, [getWorker]);

  // numSpeakers: exact number of speakers if the user knows it; leave out for automatic
  const transcribe = useCallback((audio: ArrayBuffer, numSpeakers?: number) => {
    // One run at a time: a second run would replace the first one's resolve/reject
    if (resolveRef.current) return Promise.reject(new Error('A transcription is already running'));
    setError(null);
    setWords([]);
    setSegments([]);
    setLines([]);
    setProgress(null);
    setIsTranscribing(true);

    return new Promise<SpeakerLine[]>((resolve, reject) => {
      resolveRef.current = resolve;
      rejectRef.current = reject;
      const message: DiarizationWorkerMessage = { type: 'transcribe', audio, numSpeakers };
      getWorker().postMessage(message);
    });
  }, [getWorker]);

  const cleanup = useCallback(() => {
    if (!workerRef.current) return;
    workerRef.current.terminate();
    workerRef.current = null;
    rejectRef.current?.(new Error('Diarization worker stopped'));
    resolveRef.current = null;
    rejectRef.current = null;
    setIsReady(false);
    setIsLoading(false);
    setIsTranscribing(false);
    setDevice(null);
    setLoadingProgress(null);
    setProgress(null);
  }, []);

  return {
    isLoading,
    isReady,
    isTranscribing,
    device,
    words,
    segments,
    lines,
    loadingProgress,
    progress,
    error,
    loadModels,
    transcribe,
    cleanup
  };
};