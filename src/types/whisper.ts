// Shared types for normal transcription (no speaker labels).
// Used by src/workers/whisper-worker.ts, src/hooks/useWhisperWorker.ts and the UI.
// Kept out of the worker file: importing a worker file from the page runs the worker's code on the page too.

/** Where the model runs. */
export type Device = 'webgpu' | 'wasm';

/** One Whisper model the user can pick. */
export interface ModelConfig {
  name: string;
  path: string;                 // folder under public/models/
  language?: string;
  is_multilingual?: boolean;
  quantized?: boolean;
  dtype?: 'fp16' | 'fp32' | 'q8' | 'q4';
}

/** One timestamped line. Times are seconds from the start of the recording. */
export interface TranscriptionSegment {
  text: string;
  timestamp: [number, number];
}

export interface TranscriptionResult {
  text: string;
  chunks?: TranscriptionSegment[];
}

/** How far through the audio a run is, in seconds. */
export interface AudioProgress {
  done: number;
  total: number;
}

/** Model download progress, shown while loading. */
export interface LoadingProgress {
  status: string;
  progress: number;
  file: string;
}

/** Messages the app sends to the whisper worker. */
export interface WorkerMessage {
  type: 'load' | 'transcribe' | 'configure';
  modelConfig?: ModelConfig;
  audio?: ArrayBuffer;
  options?: Record<string, any>;
}

/** Messages the whisper worker sends back to the app. */
export interface WorkerResponse {
  type: 'loading' | 'ready' | 'transcribe-start' | 'progress' | 'transcribe-complete' | 'partial' | 'error' | 'configured';
  status?: string;
  progress?: number;
  file?: string;
  result?: TranscriptionResult;
  segment?: TranscriptionSegment;
  error?: string;
  modelConfig?: ModelConfig;
  device?: Device;              // sent with 'ready': where the model actually loaded
  done?: number;                // sent with 'progress': seconds of audio transcribed so far
  total?: number;               // sent with 'progress': length of the audio in seconds
}
