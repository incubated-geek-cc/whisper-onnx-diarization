// Shared types for the speaker-diarization feature.
// Used by src/workers/diarization-worker.ts and src/hooks/useDiarizationWorker.ts

/** One word from Whisper. Times are seconds from the start of the video. */
export interface WordChunk {
  text: string;
  timestamp: [number, number | null];   // end can be missing for the very last word
}

/** One speaker turn from pyannote. */
export interface SpeakerSegment {
  id: number;           // speaker number from pyannote
  label: string;        // speaker label from the model's config
  start: number;        // seconds
  end: number;          // seconds
  confidence: number;   // 0–1
}

/** One line on screen: consecutive words spoken by the same speaker. */
export interface SpeakerLine {
  speaker: string;      // pyannote label; the display name ("George") comes from the rename map
  text: string;
  start: number;
  end: number;
}

/** Speaker mode runs in two steps: Whisper first, then pyannote. */
export type DiarizationStage = 'transcribing' | 'labelling';

/** Messages the app sends to the diarization worker. */
export type DiarizationWorkerMessage =
  | { type: 'load' }
  | { type: 'transcribe'; audio: ArrayBuffer; numSpeakers?: number };   // numSpeakers: exact count if known

/** Messages the diarization worker sends back to the app. */
export type DiarizationWorkerResponse =
  | { type: 'loading'; status: string; progress: number; file: string }
  | { type: 'ready'; device: 'webgpu' | 'wasm' }
  | { type: 'progress'; stage: DiarizationStage; done: number; total: number }   // seconds of audio processed
  | { type: 'partial'; words: WordChunk[] }               // live text, no speakers yet
  | { type: 'segments'; segments: SpeakerSegment[] }      // pyannote finished
  | { type: 'complete'; lines: SpeakerLine[] }            // merged, ready to display
  | { type: 'error'; error: string };