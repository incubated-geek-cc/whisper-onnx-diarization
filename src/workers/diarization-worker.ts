import {
  pipeline,
  env,
  AutoProcessor,
  AutoModelForAudioFrameClassification,
  WavLMForXVector
} from '@huggingface/transformers';
import { clusterVoiceprints } from './speaker-clustering';
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
const VOICE_MODEL = 'Xenova/wavlm-base-plus-sv';   // voiceprints (speaker embeddings)
const SAMPLE_RATE = 16000;

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
let voiceProcessor: any = null;
let voiceModel: any = null;
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

  // Voiceprint model, quantized (model_quantized.onnx), on WASM like pyannote
  voiceProcessor = await AutoProcessor.from_pretrained(VOICE_MODEL, { progress_callback: onProgress });
  voiceModel = await WavLMForXVector.from_pretrained(VOICE_MODEL, {
    device: 'wasm',
    dtype: 'q8',
    progress_callback: onProgress
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

const isRealSpeaker = (label: string) => label !== 'NO_SPEAKER' && !label.includes('+');

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

// ── Who speaks when: pyannote turns + WavLM voiceprints + grouping ───────────
// 1. pyannote finds speech turns in 60 s chunks (overlapping by 10 s). Running it on a whole long
//    recording at once needs gigabytes of memory, and it only tells apart 3 voices per chunk,
//    numbered from scratch in every chunk.
// 2. For each voice in each chunk, WavLM turns up to 10 s of that voice into a voiceprint
//    (512 numbers; the same person gives similar numbers).
// 3. All voiceprints of the whole recording are grouped (speaker-clustering.ts): similar ones are one
//    speaker. So any number of speakers works, and someone who comes back later keeps their label.
const SEG_CHUNK_SEC = 60;
const SEG_OVERLAP_SEC = 10;
const VOICE_MAX_SEC = 10;        // audio per voiceprint
const VOICE_MIN_SEC = 0.5;       // less speech than this in a chunk: too short for a reliable voiceprint
const SAME_SPEAKER_SIMILARITY = 0.8;   // grouping threshold when the number of speakers is not given

interface ChunkVoice {
  chunk: number;
  segments: SpeakerSegment[];    // this voice's turns, already cut to the part of the chunk it owns
  voiceprint: Float32Array;
}

// Up to VOICE_MAX_SEC of one voice's audio, longest turns first
function voiceSamples(audio: Float32Array, turns: SpeakerSegment[]): Float32Array {
  const pieces: Float32Array[] = [];
  let total = 0;
  const max = VOICE_MAX_SEC * SAMPLE_RATE;
  for (const t of [...turns].sort((a, b) => (b.end - b.start) - (a.end - a.start))) {
    if (total >= max) break;
    const from = Math.floor(t.start * SAMPLE_RATE);
    const to = Math.min(Math.floor(t.end * SAMPLE_RATE), from + (max - total));
    if (to > from) { pieces.push(audio.subarray(from, to)); total += to - from; }
  }
  const out = new Float32Array(total);
  let at = 0;
  for (const p of pieces) { out.set(p, at); at += p.length; }
  return out;
}

async function labelSpeakers(audio: Float32Array, numSpeakers?: number): Promise<SpeakerSegment[]> {
  const totalSec = audio.length / SAMPLE_RATE;
  const chunkSize = SEG_CHUNK_SEC * SAMPLE_RATE;
  const step = (SEG_CHUNK_SEC - SEG_OVERLAP_SEC) * SAMPLE_RATE;
  const voices: ChunkVoice[] = [];
  post({ type: 'progress', stage: 'labelling', done: 0, total: totalSec });

  for (let position = 0, chunk = 0; position < audio.length; position += step, chunk++) {
    const piece = audio.slice(position, position + chunkSize);
    const start = position / SAMPLE_RATE;
    const end = start + piece.length / SAMPLE_RATE;
    const isFirst = position === 0;
    const isLast = position + chunkSize >= audio.length;

    // 1. Speech turns in this chunk (local labels SPEAKER_1..3; overlapped speech is skipped)
    const inputs = await segProcessor(piece);
    const { logits } = await segModel(inputs);
    const raw = segProcessor.post_process_speaker_diarization(logits, piece.length)[0];
    const turns: SpeakerSegment[] = raw
      .map((t: any) => ({
        id: t.id,
        label: segModel.config.id2label[t.id] as string,
        start: t.start + start,
        end: Math.min(t.end + start, end),
        confidence: t.confidence
      }))
      .filter((t: SpeakerSegment) => isRealSpeaker(t.label) && t.end > t.start);

    // The part of the chunk it "owns", so the 10 s overlap isn't counted twice
    const ownFrom = isFirst ? 0 : start + SEG_OVERLAP_SEC / 2;
    const ownTo = isLast ? Infinity : end - SEG_OVERLAP_SEC / 2;

    // 2. One voiceprint per local voice
    for (const label of new Set(turns.map(t => t.label))) {
      const own = turns.filter(t => t.label === label);
      const speech = own.reduce((sum, t) => sum + (t.end - t.start), 0);
      if (speech < VOICE_MIN_SEC) continue;
      const voiceInputs = await voiceProcessor(voiceSamples(audio, own));
      const { embeddings } = await voiceModel(voiceInputs);
      const segments = own
        .map(t => ({ ...t, start: Math.max(t.start, ownFrom), end: Math.min(t.end, ownTo) }))
        .filter(t => t.end > t.start);
      voices.push({ chunk, segments, voiceprint: new Float32Array(embeddings.data) });
    }

    post({ type: 'progress', stage: 'labelling', done: Math.min(end, totalSec), total: totalSec });
    if (isLast) break;
  }

  // 3. Group the voiceprints of the whole recording into speakers
  const speakerOf = clusterVoiceprints(
    voices.map(v => v.voiceprint),
    voices.map(v => v.chunk),
    { threshold: SAME_SPEAKER_SIMILARITY, numSpeakers }
  );
  return voices
    .flatMap((v, i) => v.segments.map(t => ({ ...t, id: speakerOf[i], label: `SPEAKER_${speakerOf[i] + 1}` })))
    .sort((a, b) => a.start - b.start);
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

  const segments = await labelSpeakers(audio, numSpeakers);
  post({ type: 'segments', segments });

  const lines = mergeWordsWithSpeakers(words, segments);
  post({ type: 'complete', lines });
}

// ── Messages from the app ────────────────────────────────────────────────────
self.addEventListener('message', async (event: MessageEvent<DiarizationWorkerMessage>) => {
  const msg = event.data;
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
});