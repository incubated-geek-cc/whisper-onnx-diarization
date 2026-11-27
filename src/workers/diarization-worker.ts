import {
  pipeline,
  env,
  AutoProcessor,
  AutoModelForAudioFrameClassification
} from '@huggingface/transformers';
import * as ort from 'onnxruntime-web';   // the same ONNX Runtime instance Transformers.js uses
import { labelSpeakers, isRealSpeaker, SAMPLE_RATE } from './speaker-labelling';
import { kaldiFbank } from './kaldi-fbank';
import type {
  WordChunk,
  SpeakerSegment,
  SpeakerLine,
  DiarizationWorkerMessage,
  DiarizationWorkerResponse
} from '@/types/diarization';

// ── Local models only (same settings as whisper-worker.ts) ───────────────────
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = '/models/';
env.backends.onnx.wasm.wasmPaths = '/ort/'; // engine files from public/ort, never the CDN
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false; // we are already inside a worker

const ASR_MODEL = 'onnx-community/whisper-base_timestamped';
const SEGMENTATION_MODEL = 'onnx-community/pyannote-segmentation-3.0';
// Voiceprints (speaker embeddings): WeSpeaker ResNet34, the embedding model of pyannote's own pipeline
// (speaker-diarization-community-1), exported to ONNX. fp32: the int8 file uses ConvInteger, which the
// WASM backend doesn't support. Its input is Kaldi-style fbank features (kaldi-fbank.ts), output 256 numbers.
const VOICE_MODEL_FILE = 'FredrikKarlssonSpeech/pyannote-speaker-diarization-onnx/embedding/model.onnx';

// dtype decides which .onnx file is loaded:
//   fp32 → encoder_model.onnx          q4 → decoder_model_merged_q4.onnx
//   q8   → *_quantized.onnx
const ASR_CONFIG: Record<'webgpu' | 'wasm', any> = {
  webgpu: { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' } },
  wasm: { device: 'wasm', dtype: 'q8' }
};

let transcriber: any = null;
let segProcessor: any = null;
let segModel: any = null;
let voiceSession: ort.InferenceSession | null = null;
let activeDevice: 'webgpu' | 'wasm' = 'wasm';

const post = (msg: DiarizationWorkerResponse) => self.postMessage(msg);

const onProgress = (data: any) => {
  post({
    type: 'loading',
    status: data.status ?? '',
    progress: data.progress ?? 0,
    file: data.file ?? ''
  });
};

// ── A model file from public/models, kept in the browser's Cache Storage after the first download ─
const MODEL_CACHE = 'whisper-onnx-models';

async function loadModelFile(file: string): Promise<Uint8Array> {
  const url = new URL(`${env.localModelPath}${file}`, self.location.origin).href;
  const cache = typeof caches !== 'undefined' ? await caches.open(MODEL_CACHE).catch(() => null) : null;
  const cached = await cache?.match(url);
  if (cached) return new Uint8Array(await cached.arrayBuffer());

  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`Could not load ${file} (${response.status})`);
  const total = Number(response.headers.get('Content-Length')) || 0;
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let received = 0;
  onProgress({ status: 'initiate', file, progress: 0 });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    received += value.length;
    if (total) onProgress({ status: 'progress', file, progress: (received / total) * 100 });
  }
  const bytes = new Uint8Array(received);
  let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.length; }
  await cache?.put(url, new Response(bytes.slice(), { headers: { 'Content-Type': 'application/octet-stream' } })).catch(() => {});
  onProgress({ status: 'done', file, progress: 100 });
  return bytes;
}

// Voiceprint of up to 10 s of one person's clean speech
async function embed(speech: Float32Array): Promise<Float32Array> {
  const { data, frames } = kaldiFbank(speech);
  const outputs = await voiceSession!.run({ fbank: new ort.Tensor('float32', data, [1, frames, 80]) });
  return new Float32Array(outputs.embedding.data as Float32Array);
}

// ── WebGPU check: the API can exist while no usable GPU adapter is available ─
async function detectDevice(): Promise<'webgpu' | 'wasm'> {
  try {
    if (!navigator.gpu) return 'wasm';
    const adapter = await navigator.gpu.requestAdapter();
    return adapter ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

// ── Load the three models (once) ─────────────────────────────────────────────
// Picking "Transcript + speakers" starts loading; pressing Transcribe before that finishes used to
// start a second, parallel load of the same models, which could stall at "0 words".
// Now every caller waits for the same single load.
let loading: Promise<void> | null = null;

function load(): Promise<void> {
  if (!loading) {
    loading = loadModels().catch((err) => {
      loading = null;          // let the next attempt try again
      throw err;
    });
  }
  return loading.then(() => post({ type: 'ready', device: activeDevice }));
}

async function loadModels() {

  activeDevice = await detectDevice();
  try {
    transcriber = await pipeline('automatic-speech-recognition', ASR_MODEL, {
      ...ASR_CONFIG[activeDevice],
      progress_callback: onProgress
    });
  } catch (err) {
    if (activeDevice !== 'webgpu') throw err;
    console.warn('[Diarization] WebGPU failed, falling back to WASM:', err);
    activeDevice = 'wasm';
    transcriber = await pipeline('automatic-speech-recognition', ASR_MODEL, {
      ...ASR_CONFIG.wasm,
      progress_callback: onProgress
    });
  }

  // pyannote always runs on WASM: this model class is not supported on WebGPU
  segProcessor = await AutoProcessor.from_pretrained(SEGMENTATION_MODEL, {
    progress_callback: onProgress
  });
  segModel = await AutoModelForAudioFrameClassification.from_pretrained(SEGMENTATION_MODEL, {
    device: 'wasm',
    dtype: 'fp32',
    progress_callback: onProgress
  });

  // Voiceprint model (plain ONNX file, so loaded with ONNX Runtime directly), on WASM like pyannote
  voiceSession = await ort.InferenceSession.create(await loadModelFile(VOICE_MODEL_FILE), {
    executionProviders: ['wasm']
  });

  console.log('[Diarization] models ready on', activeDevice);
}

// ── Turning words + speaker turns into readable lines ────────────────────────
// 1. collapseRepeats: drop runaway loops like "[screaming] [screaming] …"
// 2. toSentences:     group words into sentences (break at . ? ! or a pause)
// 3. speakerFor:      give each sentence the speaker who talks most during it
// 4. toLines:         join consecutive sentences by the same speaker, break at long pauses

const MAX_REPEATS = 2;        // same word allowed at most twice in a row
const SENTENCE_PAUSE = 1.5;   // seconds of silence that end a sentence
const LINE_PAUSE = 3;         // seconds of silence that start a new line
const MAX_SENTENCE_WORDS = 40;

interface Sentence {
  text: string;
  start: number;
  end: number;
}

const normalise = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function collapseRepeats(words: WordChunk[]): WordChunk[] {
  const kept: WordChunk[] = [];
  let previous = '';
  let count = 0;
  for (const word of words) {
    const key = normalise(word.text);
    count = key !== '' && key === previous ? count + 1 : 1;
    previous = key;
    if (count <= MAX_REPEATS) kept.push(word);
  }
  return kept;
}

function toSentences(words: WordChunk[]): Sentence[] {
  const sentences: Sentence[] = [];
  let current: Sentence | null = null;
  let wordCount = 0;

  words.forEach((word, i) => {
    const start = word.timestamp[0];
    const end = word.timestamp[1] ?? start;
    if (!current) {
      current = { text: '', start, end };
      wordCount = 0;
    }
    current.text += word.text;            // Whisper words already start with a space
    current.end = Math.max(current.end, end);
    wordCount++;

    const next = words[i + 1];
    const endsWithPunctuation = /[.?!]["')\]]*$/.test(word.text.trim());
    const pauseAfter = next ? next.timestamp[0] - end : Infinity;
    const isCoarse = word.text.trim().includes(' ');   // squashed/rescued text arrives as one chunk

    if (!next || endsWithPunctuation || pauseAfter > SENTENCE_PAUSE || isCoarse || wordCount >= MAX_SENTENCE_WORDS) {
      current.text = current.text.trim();
      if (current.text) sentences.push(current);
      current = null;
    }
  });
  return sentences;
}

// The speaker with the most talking time inside the sentence wins.
// If nobody overlaps it (it falls in a gap), the nearest speaker turn wins.
function speakerFor(sentence: Sentence, segments: SpeakerSegment[]): string {
  const talkTime = new Map<string, number>();
  let nearest = 'UNKNOWN';
  let nearestGap = Infinity;

  for (const seg of segments) {
    if (!isRealSpeaker(seg.label)) continue;
    const overlap = Math.min(sentence.end, seg.end) - Math.max(sentence.start, seg.start);
    if (overlap > 0) {
      talkTime.set(seg.label, (talkTime.get(seg.label) ?? 0) + overlap);
    } else if (-overlap < nearestGap) {
      nearestGap = -overlap;
      nearest = seg.label;
    }
  }

  let best = nearest;
  let bestTime = 0;
  for (const [label, time] of talkTime) {
    if (time > bestTime) {
      bestTime = time;
      best = label;
    }
  }
  return best;
}

function toLines(sentences: Sentence[], segments: SpeakerSegment[]): SpeakerLine[] {
  const lines: SpeakerLine[] = [];
  for (const sentence of sentences) {
    const speaker = speakerFor(sentence, segments);
    const last = lines[lines.length - 1];
    if (last && last.speaker === speaker && sentence.start - last.end <= LINE_PAUSE) {
      last.text += ' ' + sentence.text;
      last.end = Math.max(last.end, sentence.end);
    } else {
      lines.push({ speaker, text: sentence.text, start: sentence.start, end: sentence.end });
    }
  }
  return lines;
}

function mergeWordsWithSpeakers(words: WordChunk[], segments: SpeakerSegment[]): SpeakerLine[] {
  const sorted = [...words].sort((a, b) => a.timestamp[0] - b.timestamp[0]);
  return toLines(toSentences(collapseRepeats(sorted)), segments);
}

// ── Transcribe (streams words) → pyannote → merge ────────────────────────────
async function transcribe(audioBuffer: ArrayBuffer, numSpeakers?: number) {
  const audio = new Float32Array(audioBuffer);
  const windowSize = 30 * SAMPLE_RATE;
  const step = 25 * SAMPLE_RATE; // windows overlap by 5 seconds
  const options = {
    language: 'en',
    task: 'transcribe',
    return_timestamps: 'word',
    chunk_length_s: 30
  };

  const words: WordChunk[] = [];
  let lastEnd = 0;
  const totalSec = audio.length / SAMPLE_RATE;
  post({ type: 'progress', stage: 'transcribing', done: 0, total: totalSec });

  for (let position = 0; position < audio.length; position += step) {
    const offset = position / SAMPLE_RATE;
    const slice = audio.slice(position, position + windowSize);

    const windowSec = slice.length / SAMPLE_RATE;
    const isLast = position + windowSize >= audio.length;
    // Each window "owns" only its first 25 s: the next window starts 25 s later and covers the rest.
    // The last window owns everything up to the end of the audio.
    const ownUntil = isLast ? Infinity : step / SAMPLE_RATE;
    const coarseEnd = offset + Math.min(windowSec, ownUntil);

    let result = await transcriber(slice, options);

    // Same fallback as whisper-worker.ts: an empty window is retried without timestamps
    let rescued = false;
    if (!result.text?.trim()) {
      const plain = await transcriber(slice, { ...options, return_timestamps: false });
      if (plain.text?.trim()) {
        result = { text: plain.text, chunks: [] };
        rescued = true;
      }
    }

    const fresh: WordChunk[] = [];

    if (rescued) {
      // No word times at all: keep the text as one coarse line over the part this window owns
      fresh.push({ text: result.text, timestamp: [offset, coarseEnd] });
    } else {
      const squashed: string[] = [];

      for (const w of result.chunks ?? []) {
        const relStart: number = w.timestamp[0];
        const relEnd: number = w.timestamp[1] ?? relStart;

        // Squashed words: Whisper couldn't place them and piled them at the very end of the window
        if (windowSec >= 29 && relStart >= windowSec - 1 && relEnd - relStart < 0.05) {
          squashed.push(w.text);
          continue;
        }

        // Words after 25 s belong to the next window, which hears them from its start
        if (relStart >= ownUntil) continue;

        const start = relStart + offset;
        const end = relEnd + offset;
        // A word straddling the 25 s line can appear in both windows: keep it only once
        if (start < lastEnd - 0.1) continue;

        fresh.push({ text: w.text, timestamp: [start, end] });
        lastEnd = end;
      }

      if (squashed.length > 0) {
        // Keep their text as one coarse line at the start of this window, instead of at a fake time
        fresh.unshift({ text: squashed.join(''), timestamp: [offset, coarseEnd] });
      }
    }

    if (fresh.length > 0) {
      words.push(...fresh);
      post({ type: 'partial', words: fresh });
    }
    post({ type: 'progress', stage: 'transcribing', done: Math.min(offset + windowSec, totalSec), total: totalSec });
  }

  const segments = await labelSpeakers(
    audio,
    {
      segProcessor,
      segModel,
      embed
    },
    {
      numSpeakers,
      onProgress: (done, total) => post({ type: 'progress', stage: 'labelling', done, total })
    }
  );
  post({ type: 'segments', segments });

  const lines = mergeWordsWithSpeakers(words, segments);
  post({ type: 'complete', lines });
}

// ── Messages from the app ────────────────────────────────────────────────────
// Requests run one after another. ONNX Runtime allows one model run at a time, and the voiceprint
// model is called directly, outside Transformers.js' own queue: two transcriptions side by side
// would overlap their runs and fail with "Session mismatch".
let queue: Promise<void> = Promise.resolve();

async function handle(msg: DiarizationWorkerMessage) {
  try {
    if (msg.type === 'load') {
      await load();
    } else if (msg.type === 'transcribe') {
      await load();            // returns at once if the models are already loaded
      await transcribe(msg.audio, msg.numSpeakers);
    }
  } catch (error) {
    post({ type: 'error', error: error instanceof Error ? error.message : String(error) });
  }
}

self.addEventListener('message', (event: MessageEvent<DiarizationWorkerMessage>) => {
  queue = queue.then(() => handle(event.data));
});