// Who speaks when: pyannote turns + chaining across windows + voiceprints + grouping.
// Shared by diarization-worker.ts (in the browser) and scripts/eval-diarization.ts (in Node),
// so the accuracy evaluation measures exactly the code the app runs.
//
// 1. pyannote-segmentation-3.0 hears 10 s at a time (the length it was trained on) and can tell
//    apart at most 3 voices in those 10 s, numbered from scratch in every window. Windows overlap
//    by 5 s, so the model sees every moment twice.
// 2. Chaining: a voice in one window is the same voice in the next if both windows hear it talking
//    during their shared 5 s. Chained windows form a "track": one person's continuous stretch.
//    A track ends when that person is quiet for long enough to miss a whole overlap.
// 3. A voiceprint model turns up to 10 s of each track's clean speech into a list of numbers;
//    the same person gives similar numbers.
// 4. All voiceprints are grouped (speaker-clustering.ts), so someone who comes back after a pause
//    is recognised again. Tracks that talk in the same window are different people and stay apart.

import { clusterVoiceprints } from './speaker-clustering';
import type { SpeakerSegment } from '../types/diarization';

export const SAMPLE_RATE = 16000;
export const WINDOW_SEC = 10;                 // pyannote-segmentation-3.0 was trained on 10 s windows
export const STEP_SEC = 5;                    // so neighbouring windows share 5 s
export const LINK_MIN_SEC = 0.3;              // heard together this long in the shared 5 s = same voice
export const VOICE_MAX_SEC = 10;              // audio per voiceprint
export const VOICE_MIN_SEC = 0.5;             // less clean speech than this: too short for a reliable voiceprint
export const SAME_SPEAKER_SIMILARITY = 0.4;   // grouping threshold when the number of speakers is not given (tuned for WeSpeaker ResNet34)

/** The loaded segmentation model, and a function that turns clean speech into a voiceprint. */
export interface SpeakerModels {
  segProcessor: any;     // AutoProcessor for pyannote-segmentation-3.0
  segModel: any;         // AutoModelForAudioFrameClassification
  embed: (speech: Float32Array) => Promise<Float32Array>;
}

export interface LabelOptions {
  numSpeakers?: number;                                // exact count if known, otherwise Auto
  threshold?: number;                                  // defaults to SAME_SPEAKER_SIMILARITY
  useVoiceprints?: boolean;                            // false = chaining only, no voiceprints (for the evaluation)
  onProgress?: (doneSec: number, totalSec: number) => void;
  onTracks?: (tracks: Track[]) => void;                // for the evaluation script
}

/** One person's continuous stretch, chained across overlapping windows. */
export interface Track {
  segments: SpeakerSegment[];      // turns this track owns, including overlapped speech
  alone: SpeakerSegment[];         // the subset where this voice speaks alone (used for the voiceprint)
  windows: Set<number>;            // windows in which it speaks
  voiceprint: Float32Array | null;
  finished: boolean;
}

interface LocalTurn {
  label: string;                   // SPEAKER_1..3, only meaningful inside its window
  start: number;
  end: number;
  confidence: number;
  overlap: boolean;                // spoken while another voice also talks
}

/** Final labels are SPEAKER_1, SPEAKER_2, …; anything else (e.g. UNKNOWN) is not a person. */
export const isRealSpeaker = (label: string) => /^SPEAKER_\d+$/.test(label);

// pyannote-segmentation-3.0 labels every frame as one of:
//   NO_SPEAKER · SPEAKER_1 · SPEAKER_2 · SPEAKER_3 · SPEAKERS_1_AND_2 · SPEAKERS_1_AND_3 · SPEAKERS_2_AND_3
// so overlapped speech is its own label. It must not be treated as an extra person.
function localSpeakersOf(label: string): string[] {
  if (/^SPEAKER_\d+$/.test(label)) return [label];
  const both = /^SPEAKERS_(\d+)_AND_(\d+)$/.exec(label);
  return both ? [`SPEAKER_${both[1]}`, `SPEAKER_${both[2]}`] : [];
}

// Seconds that turns a and b are both active inside [from, to]
const together = (a: LocalTurn, b: LocalTurn, from: number, to: number) =>
  Math.max(0, Math.min(a.end, b.end, to) - Math.max(a.start, b.start, from));

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

/** Labels who speaks when in 16 kHz mono audio. Returns turns labelled SPEAKER_1, SPEAKER_2, … */
export async function labelSpeakers(
  audio: Float32Array,
  models: SpeakerModels,
  options: LabelOptions = {}
): Promise<SpeakerSegment[]> {
  const { segProcessor, segModel, embed } = models;
  const { numSpeakers, threshold = SAME_SPEAKER_SIMILARITY, useVoiceprints = true, onProgress } = options;
  const totalSec = audio.length / SAMPLE_RATE;
  const windowSize = WINDOW_SEC * SAMPLE_RATE;
  const step = STEP_SEC * SAMPLE_RATE;
  const half = (WINDOW_SEC - STEP_SEC) / 2;     // each window owns its middle part; neighbours own the rest
  const tracks: Track[] = [];
  onProgress?.(0, totalSec);

  // A track whose voice did not carry on into the next window is complete: make its voiceprint now
  const finish = async (track: Track) => {
    if (track.finished) return;
    track.finished = true;
    if (!useVoiceprints) return;
    const speech = track.alone.reduce((sum, t) => sum + (t.end - t.start), 0);
    if (speech < VOICE_MIN_SEC) return;
    track.voiceprint = await embed(voiceSamples(audio, track.alone));
  };

  let previous: { end: number; turns: LocalTurn[]; trackOf: Map<string, number> } | null = null;

  for (let position = 0, w = 0; position < audio.length; position += step, w++) {
    const piece = audio.slice(position, position + windowSize);
    const start = position / SAMPLE_RATE;
    const end = start + piece.length / SAMPLE_RATE;
    const isFirst = position === 0;
    const isLast = position + windowSize >= audio.length;

    // 1. Speech turns in this window. An overlap turn becomes a turn for each of its two voices.
    const { logits } = await segModel(await segProcessor(piece));
    const raw = segProcessor.post_process_speaker_diarization(logits, piece.length)[0];
    const turns: LocalTurn[] = raw.flatMap((t: any) => {
      const voices = localSpeakersOf(segModel.config.id2label[t.id] as string);
      return voices.map(label => ({
        label,
        start: t.start + start,
        end: Math.min(t.end + start, end),
        confidence: t.confidence,
        overlap: voices.length > 1
      }));
    }).filter((t: LocalTurn) => t.end > t.start);
    const labels = [...new Set(turns.map(t => t.label))];

    // 2. Chain each voice to the previous window's voice it talks together with in the shared part
    const trackOf = new Map<string, number>();
    if (previous) {
      const pairs: { track: number; label: string; seconds: number }[] = [];
      for (const [prevLabel, track] of previous.trackOf) {
        for (const label of labels) {
          let seconds = 0;
          for (const a of previous.turns) {
            if (a.label !== prevLabel) continue;
            for (const b of turns) if (b.label === label) seconds += together(a, b, start, previous.end);
          }
          if (seconds >= LINK_MIN_SEC) pairs.push({ track, label, seconds });
        }
      }
      pairs.sort((a, b) => b.seconds - a.seconds);          // strongest agreement first, one-to-one
      const usedTracks = new Set<number>();
      for (const p of pairs) {
        if (usedTracks.has(p.track) || trackOf.has(p.label)) continue;
        trackOf.set(p.label, p.track);
        usedTracks.add(p.track);
      }
      for (const track of previous.trackOf.values()) {
        if (!usedTracks.has(track)) await finish(tracks[track]);
      }
    }

    // The part of the recording this window owns, so shared seconds aren't counted twice
    const ownFrom = isFirst ? 0 : start + half;
    const ownTo = isLast ? Infinity : end - half;
    for (const label of labels) {
      if (!trackOf.has(label)) {
        tracks.push({ segments: [], alone: [], windows: new Set(), voiceprint: null, finished: false });
        trackOf.set(label, tracks.length - 1);
      }
      const track = tracks[trackOf.get(label)!];
      for (const t of turns) {
        if (t.label !== label) continue;
        const from = Math.max(t.start, ownFrom);
        const to = Math.min(t.end, ownTo);
        if (to <= from) continue;
        const segment: SpeakerSegment = { id: 0, label, start: from, end: to, confidence: t.confidence };
        track.segments.push(segment);
        if (!t.overlap) track.alone.push(segment);
        track.windows.add(w);
      }
    }

    previous = { end, turns, trackOf };
    onProgress?.(Math.min(end, totalSec), totalSec);
    if (isLast) break;
  }
  if (previous) for (const track of previous.trackOf.values()) await finish(tracks[track]);

  // 3. Group tracks into speakers. Tracks heard in the same window are different people.
  const kept = tracks.filter(t => t.segments.length > 0 && (!useVoiceprints || t.voiceprint));
  options.onTracks?.(kept);
  const apart: [number, number][] = [];
  for (let i = 0; i < kept.length; i++) {
    for (let j = i + 1; j < kept.length; j++) {
      for (const w of kept[i].windows) if (kept[j].windows.has(w)) { apart.push([i, j]); break; }
    }
  }
  const speakerOf = useVoiceprints
    ? clusterVoiceprints(kept.map(t => t.voiceprint!), apart, { threshold, numSpeakers })
    : kept.map((_, i) => i);

  return kept
    .flatMap((t, i) => t.segments.map(s => ({ ...s, id: speakerOf[i], label: `SPEAKER_${speakerOf[i] + 1}` })))
    .sort((a, b) => a.start - b.start);
}
