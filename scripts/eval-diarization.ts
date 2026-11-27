// Measures how accurate the speaker labels are, using the exact labelling code the app runs
// (src/workers/speaker-labelling.ts) and the same local models (public/models).
//
//   npm run eval                       every NAME.wav + NAME.rttm pair in eval/
//   npm run eval -- path/to/folder     another folder
//   npm run eval -- --mode auto        only Auto (default: both Auto and known speaker count)
//   npm run eval -- --chain-only       skip the voiceprints, to see what they add
//   npm run eval -- --voice wavlm      WavLM voiceprints instead of ResNet34, for comparison
//                                      (needs Xenova/wavlm-base-plus-sv in public/models)
//   npm run eval -- --seg community1   pyannote community-1 segmentation instead of 3.0
//   npm run eval -- --threshold 0.3    grouping threshold (default: the app's value for that voice model)
//
// Each recording needs a reference file NAME.rttm (human labels, the standard RTTM format) and,
// optionally, NAME.uem (the part of the recording to score). Audio must be 16 kHz WAV (mono or
// stereo, 16-bit or 32-bit float). Results go to eval/results.json, and the app's own labels go to
// eval/out/NAME.<mode>.rttm so they can be inspected or scored with another tool.
//
// Score: Diarization Error Rate (DER) = (missed speech + false alarm + speaker confusion) / total speech.
// Lower is better; 0% is perfect. Two standard ways of scoring are reported:
//   full       every frame counts, including overlapped speech, no collar
//   forgiving  0.25 s collar around each reference boundary, overlapped speech not scored

import fs from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import {
  env,
  Tensor,
  AutoProcessor,
  AutoModelForAudioFrameClassification,
  WavLMForXVector
} from '@huggingface/transformers';
import { labelSpeakers, SAMPLE_RATE, SAME_SPEAKER_SIMILARITY, type SpeakerModels } from '../src/workers/speaker-labelling';
import { kaldiFbank } from '../src/workers/kaldi-fbank';
import type { SpeakerSegment } from '../src/types/diarization';

// ── Settings ─────────────────────────────────────────────────────────────────
const FRAME = 0.01;            // scoring resolution: 10 ms
const COLLAR = 0.25;           // seconds, for the forgiving score

type Mode = 'auto' | 'known';

interface Turn { speaker: string; start: number; end: number; }
interface Region { start: number; end: number; }
interface Errors { total: number; missed: number; falseAlarm: number; confusion: number; }

// ── Command line ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const modeArg = args.includes('--mode') ? args[args.indexOf('--mode') + 1] : 'both';
const chainOnly = args.includes('--chain-only');
const option = (name: string, fallback: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const voice = option('--voice', 'resnet') as 'wavlm' | 'resnet';
const seg = option('--seg', 'pyannote3') as 'pyannote3' | 'community1';
// Cosine similarity needed to merge. ResNet34: the app's value. WavLM: its best value in the sweep
// on the evaluation data (0.85); the two models' similarity scores are on different scales.
const threshold = Number(option('--threshold', voice === 'resnet' ? String(SAME_SPEAKER_SIMILARITY) : '0.85'));
const VALUE_OPTIONS = ['--mode', '--voice', '--seg', '--threshold'];
const folder = path.resolve(args.find((a, i) => !a.startsWith('--') && !VALUE_OPTIONS.includes(args[i - 1])) ?? 'eval');
const modes: Mode[] = modeArg === 'auto' ? ['auto'] : modeArg === 'known' ? ['known'] : ['auto', 'known'];

// ── Reading files ────────────────────────────────────────────────────────────
function readWav(file: string): Float32Array {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path.basename(file)} is not a WAV file`);
  }
  let format = 0, channels = 0, rate = 0, bits = 0, dataStart = -1, dataSize = 0;
  for (let at = 12; at + 8 <= buf.length;) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      format = buf.readUInt16LE(at + 8);
      channels = buf.readUInt16LE(at + 10);
      rate = buf.readUInt32LE(at + 12);
      bits = buf.readUInt16LE(at + 22);
      if (format === 0xfffe) format = buf.readUInt16LE(at + 32);   // WAVE_FORMAT_EXTENSIBLE
    } else if (id === 'data') {
      dataStart = at + 8;
      dataSize = Math.min(size, buf.length - dataStart);
      break;
    }
    at += 8 + size + (size % 2);
  }
  if (dataStart < 0) throw new Error(`${path.basename(file)} has no audio data`);
  if (rate !== SAMPLE_RATE) {
    throw new Error(`${path.basename(file)} is ${rate} Hz; convert it first: ffmpeg -i in.wav -ac 1 -ar 16000 out.wav`);
  }
  const bytes = bits / 8;
  const frames = Math.floor(dataSize / (bytes * channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const at = dataStart + (i * channels + c) * bytes;
      if (format === 3 && bits === 32) sum += buf.readFloatLE(at);
      else if (format === 1 && bits === 16) sum += buf.readInt16LE(at) / 32768;
      else if (format === 1 && bits === 32) sum += buf.readInt32LE(at) / 2147483648;
      else throw new Error(`${path.basename(file)}: unsupported WAV format (${format}, ${bits}-bit)`);
    }
    out[i] = sum / channels;
  }
  return out;
}

// SPEAKER <file> <channel> <start> <duration> <NA> <NA> <speaker> <NA> <NA>
function readRttm(file: string): Turn[] {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map(line => line.trim().split(/\s+/))
    .filter(f => f[0] === 'SPEAKER' && f.length >= 8)
    .map(f => ({ speaker: f[7], start: Number(f[3]), end: Number(f[3]) + Number(f[4]) }))
    .filter(t => t.end > t.start);
}

// <file> <channel> <start> <end>
function readUem(file: string): Region[] {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/)
    .map(line => line.trim().split(/\s+/))
    .filter(f => f.length >= 4)
    .map(f => ({ start: Number(f[2]), end: Number(f[3]) }));
}

function writeRttm(file: string, name: string, turns: Turn[]) {
  const lines = turns.map(t =>
    `SPEAKER ${name} 1 ${t.start.toFixed(3)} ${(t.end - t.start).toFixed(3)} <NA> <NA> ${t.speaker} <NA> <NA>`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

// ── Scoring ──────────────────────────────────────────────────────────────────
// Turns → per-frame sets of speakers (as indexes into `names`)
function toFrames(turns: Turn[], frames: number, names: string[]): number[][] {
  const grid: number[][] = Array.from({ length: frames }, () => []);
  for (const t of turns) {
    let s = names.indexOf(t.speaker);
    if (s < 0) { names.push(t.speaker); s = names.length - 1; }
    const from = Math.max(0, Math.round(t.start / FRAME));
    const to = Math.min(frames, Math.round(t.end / FRAME));
    for (let f = from; f < to; f++) if (!grid[f].includes(s)) grid[f].push(s);
  }
  return grid;
}

// Hungarian algorithm (maximises total weight). weight[r][h], rectangular is fine.
function bestMapping(weight: number[][]): Map<number, number> {
  const rows = weight.length;
  const cols = rows ? weight[0].length : 0;
  const n = Math.max(rows, cols);
  if (n === 0) return new Map();
  let maxW = 0;
  for (const row of weight) for (const w of row) maxW = Math.max(maxW, w);
  // cost = maxW - weight, padded to a square matrix
  const cost = (i: number, j: number) => (i < rows && j < cols ? maxW - weight[i][j] : maxW);
  const u = new Array(n + 1).fill(0), v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0), way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(Infinity);
    const used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = cost(i0 - 1, j - 1) - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const map = new Map<number, number>();           // hypothesis speaker → reference speaker
  for (let j = 1; j <= n; j++) {
    const r = p[j] - 1, h = j - 1;
    if (r < rows && h < cols && weight[r][h] > 0) map.set(h, r);
  }
  return map;
}

function score(reference: Turn[], hypothesis: Turn[], regions: Region[], forgiving: boolean): Errors {
  const end = Math.max(...regions.map(r => r.end), ...reference.map(t => t.end), 0);
  const frames = Math.ceil(end / FRAME);
  const refNames: string[] = [], hypNames: string[] = [];
  const ref = toFrames(reference, frames, refNames);
  const hyp = toFrames(hypothesis, frames, hypNames);

  // Frames that are scored: inside the regions, minus collars / overlap when forgiving
  const scored = new Uint8Array(frames);
  for (const r of regions) {
    for (let f = Math.max(0, Math.round(r.start / FRAME)); f < Math.min(frames, Math.round(r.end / FRAME)); f++) scored[f] = 1;
  }
  if (forgiving) {
    const c = Math.round(COLLAR / FRAME);
    for (const t of reference) {
      for (const edge of [t.start, t.end]) {
        const at = Math.round(edge / FRAME);
        for (let f = Math.max(0, at - c); f < Math.min(frames, at + c); f++) scored[f] = 0;
      }
    }
    for (let f = 0; f < frames; f++) if (ref[f].length > 1) scored[f] = 0;
  }

  // Best one-to-one match between reference and hypothesis speakers (by time spoken together)
  const together = refNames.map(() => hypNames.map(() => 0));
  for (let f = 0; f < frames; f++) {
    if (!scored[f]) continue;
    for (const r of ref[f]) for (const h of hyp[f]) together[r][h]++;
  }
  const mapping = bestMapping(together);

  const e: Errors = { total: 0, missed: 0, falseAlarm: 0, confusion: 0 };
  for (let f = 0; f < frames; f++) {
    if (!scored[f]) continue;
    const nRef = ref[f].length, nHyp = hyp[f].length;
    const correct = hyp[f].filter(h => mapping.has(h) && ref[f].includes(mapping.get(h)!)).length;
    e.total += nRef;
    e.missed += Math.max(0, nRef - nHyp);
    e.falseAlarm += Math.max(0, nHyp - nRef);
    e.confusion += Math.min(nRef, nHyp) - correct;
  }
  for (const k of Object.keys(e) as (keyof Errors)[]) e[k] *= FRAME;   // frames → seconds
  return e;
}

const der = (e: Errors) => (e.total > 0 ? (e.missed + e.falseAlarm + e.confusion) / e.total : 0);
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const add = (a: Errors, b: Errors): Errors => ({
  total: a.total + b.total, missed: a.missed + b.missed,
  falseAlarm: a.falseAlarm + b.falseAlarm, confusion: a.confusion + b.confusion
});

// ── Models: same files and precision as the app ──────────────────────────────
const COMMUNITY = path.resolve('public/models/FredrikKarlssonSpeech/pyannote-speaker-diarization-onnx');

async function loadModels(): Promise<SpeakerModels> {
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.localModelPath = path.resolve('public/models') + path.sep;
  // One thread, like the browser (WASM, numThreads = 1), so timings are comparable
  const session_options = { intraOpNumThreads: 1, interOpNumThreads: 1 };
  const SEG = 'onnx-community/pyannote-segmentation-3.0';
  const segProcessor = await AutoProcessor.from_pretrained(SEG);
  let segModel: any = await AutoModelForAudioFrameClassification.from_pretrained(SEG, { device: 'cpu', dtype: 'fp32', session_options } as any);

  if (seg === 'community1') {
    // Same 7 outputs and frame rate as 3.0, so the same processor post-processes it
    const session = await ort.InferenceSession.create(path.join(COMMUNITY, 'segmentation/model.onnx'), session_options);
    const config = segModel.config;
    segModel = Object.assign(async (inputs: any) => {
      const waveform = new ort.Tensor('float32', inputs.input_values.data, inputs.input_values.dims);
      const { scores } = await session.run({ waveform });
      return { logits: new Tensor('float32', scores.data as Float32Array, scores.dims as number[]) };
    }, { config });
  }

  let embed: SpeakerModels['embed'];
  if (voice === 'resnet') {
    // WeSpeaker ResNet34 from pyannote community-1 (fp32; the int8 file needs ConvInteger, which
    // ONNX Runtime's CPU and WASM backends don't have)
    const session = await ort.InferenceSession.create(path.join(COMMUNITY, 'embedding/model.onnx'), session_options);
    embed = async (speech) => {
      const { data, frames } = kaldiFbank(speech);
      const { embedding } = await session.run({ fbank: new ort.Tensor('float32', data, [1, frames, 80]) });
      return new Float32Array(embedding.data as Float32Array);
    };
  } else {
    const VOICE = 'Xenova/wavlm-base-plus-sv';
    const voiceProcessor = await AutoProcessor.from_pretrained(VOICE);
    const voiceModel = await WavLMForXVector.from_pretrained(VOICE, { device: 'cpu', dtype: 'q8', session_options } as any);
    embed = async (speech) => new Float32Array((await voiceModel(await voiceProcessor(speech))).embeddings.data);
  }
  return { segProcessor, segModel, embed };
}

// ── Run ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(folder)) throw new Error(`Folder not found: ${folder}`);
  const names = fs.readdirSync(folder)
    .filter(f => f.toLowerCase().endsWith('.wav'))
    .map(f => f.slice(0, -4))
    .filter(n => fs.existsSync(path.join(folder, `${n}.rttm`)))
    .sort();
  if (names.length === 0) {
    throw new Error(`No NAME.wav + NAME.rttm pairs in ${folder}. Run "npm run eval:data" to download the AMI test meetings.`);
  }

  console.log(`Loading models from public/models … (segmentation: ${seg}, voiceprints: ${chainOnly ? 'none' : voice}, threshold ${threshold})`);
  const models = await loadModels();
  const outDir = path.join(folder, 'out');
  fs.mkdirSync(outDir, { recursive: true });

  const results: any[] = [];
  const totals: Record<string, { full: Errors; forgiving: Errors }> = {};
  let audioSec = 0, computeSec = 0;

  for (const name of names) {
    const audio = readWav(path.join(folder, `${name}.wav`));
    const reference = readRttm(path.join(folder, `${name}.rttm`));
    const uemFile = path.join(folder, `${name}.uem`);
    const duration = audio.length / SAMPLE_RATE;
    const regions = fs.existsSync(uemFile) ? readUem(uemFile) : [{ start: 0, end: duration }];
    const refSpeakers = new Set(reference.map(t => t.speaker)).size;
    console.log(`\n${name}: ${(duration / 60).toFixed(1)} min, ${refSpeakers} speakers in the reference`);

    for (const mode of modes) {
      const t0 = performance.now();
      const segments: SpeakerSegment[] = await labelSpeakers(audio, models, {
        numSpeakers: mode === 'known' ? refSpeakers : undefined,
        useVoiceprints: !chainOnly,
        threshold,
        onProgress: (done, total) => process.stdout.write(`\r  ${mode.padEnd(5)} ${Math.round((done / total) * 100)}%   `)
      });
      const seconds = (performance.now() - t0) / 1000;
      if (mode === 'auto') { audioSec += duration; computeSec += seconds; }

      const hypothesis: Turn[] = segments.map(s => ({ speaker: s.label, start: s.start, end: s.end }));
      writeRttm(path.join(outDir, `${name}.${mode}.rttm`), name, hypothesis);
      const full = score(reference, hypothesis, regions, false);
      const forgiving = score(reference, hypothesis, regions, true);
      const found = new Set(hypothesis.map(t => t.speaker)).size;

      totals[mode] ??= { full: { total: 0, missed: 0, falseAlarm: 0, confusion: 0 }, forgiving: { total: 0, missed: 0, falseAlarm: 0, confusion: 0 } };
      totals[mode].full = add(totals[mode].full, full);
      totals[mode].forgiving = add(totals[mode].forgiving, forgiving);

      process.stdout.write('\r');
      console.log(
        `  ${mode.padEnd(5)} DER ${pct(der(full)).padStart(6)} full, ${pct(der(forgiving)).padStart(6)} forgiving` +
        `  (missed ${pct(full.missed / full.total)}, false alarm ${pct(full.falseAlarm / full.total)}, ` +
        `confusion ${pct(full.confusion / full.total)})  speakers found ${found}/${refSpeakers}  ${seconds.toFixed(0)} s`
      );
      results.push({
        recording: name, mode, minutes: +(duration / 60).toFixed(2),
        speakers: { reference: refSpeakers, found },
        full: { der: der(full), ...full }, forgiving: { der: der(forgiving), ...forgiving },
        seconds: +seconds.toFixed(1)
      });
    }
  }

  console.log('\nOverall (weighted by speech time)');
  const summary: any = {};
  for (const mode of modes) {
    const { full, forgiving } = totals[mode];
    summary[mode] = {
      der_full: der(full), der_forgiving: der(forgiving),
      missed: full.missed / full.total, false_alarm: full.falseAlarm / full.total, confusion: full.confusion / full.total
    };
    console.log(
      `  ${mode.padEnd(5)} DER ${pct(der(full))} full, ${pct(der(forgiving))} forgiving` +
      `  (missed ${pct(summary[mode].missed)}, false alarm ${pct(summary[mode].false_alarm)}, confusion ${pct(summary[mode].confusion)})`
    );
  }
  const speed = audioSec / computeSec;
  console.log(`  speed  ${speed.toFixed(1)}x real time (Auto, 1 CPU thread): an hour of audio takes about ${(60 / speed).toFixed(0)} min`);

  fs.writeFileSync(path.join(folder, 'results.json'), JSON.stringify({
    date: new Date().toISOString(), frame_seconds: FRAME, collar_seconds: COLLAR,
    summary, speed_x_realtime: speed, recordings: results
  }, null, 2));
  console.log(`\nSaved ${path.relative(process.cwd(), path.join(folder, 'results.json'))} and the app's labels in ${path.relative(process.cwd(), outDir)}`);
}

main().catch(err => {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
