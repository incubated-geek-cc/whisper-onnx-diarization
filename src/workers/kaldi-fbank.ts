// Kaldi-style log Mel filterbank features ("fbank"), the input of the WeSpeaker ResNet34
// voiceprint model in pyannote's pipeline. Matches torchaudio.compliance.kaldi.fbank with:
//   num_mel_bins=80, frame_length=25 ms, frame_shift=10 ms, dither=0, window_type='hamming',
//   sample_frequency=16000, use_energy=False   (all other options at their defaults)
// followed by subtracting the mean of each Mel band over the whole clip, as pyannote does.

const SAMPLE_RATE = 16000;
const FRAME_LENGTH = 400;        // 25 ms
const FRAME_SHIFT = 160;         // 10 ms
const FFT_SIZE = 512;            // frame length rounded up to a power of two
const NUM_BINS = 80;
const LOW_FREQ = 20;
const HIGH_FREQ = SAMPLE_RATE / 2;
const PREEMPHASIS = 0.97;
const EPSILON = 1.1920928955078125e-7;   // torch.finfo(torch.float32).eps, the log floor
const WAVEFORM_SCALE = 32768;            // pyannote scales [-1, 1] audio to 16-bit range first

const melScale = (hz: number) => 1127 * Math.log(1 + hz / 700);

// Hamming window and the 80 triangular Mel filters are the same for every frame: compute once
const WINDOW = Float64Array.from({ length: FRAME_LENGTH }, (_, i) =>
  0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME_LENGTH - 1)));

const MEL_BANKS: { first: number; weights: Float64Array }[] = (() => {
  const binWidth = SAMPLE_RATE / FFT_SIZE;
  const melLow = melScale(LOW_FREQ);
  const melDelta = (melScale(HIGH_FREQ) - melLow) / (NUM_BINS + 1);
  const banks = [];
  for (let b = 0; b < NUM_BINS; b++) {
    const left = melLow + b * melDelta;
    const centre = left + melDelta;
    const right = centre + melDelta;
    const weights: number[] = [];
    let first = -1;
    for (let k = 0; k < FFT_SIZE / 2; k++) {               // the Nyquist bin has weight 0
      const mel = melScale(k * binWidth);
      const w = Math.max(0, Math.min((mel - left) / (centre - left), (right - mel) / (right - centre)));
      if (w > 0) {
        if (first < 0) first = k;
        weights[k - first] = w;
      } else if (first >= 0) break;
    }
    banks.push({ first: Math.max(first, 0), weights: Float64Array.from(weights, w => w ?? 0) });
  }
  return banks;
})();

// In-place radix-2 FFT of FFT_SIZE points (re, im)
const BIT_REVERSED = (() => {
  const bits = Math.log2(FFT_SIZE);
  return Uint16Array.from({ length: FFT_SIZE }, (_, i) => {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    return r;
  });
})();

function fft(re: Float64Array, im: Float64Array) {
  for (let i = 0; i < FFT_SIZE; i++) {
    const j = BIT_REVERSED[i];
    if (j > i) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let size = 2; size <= FFT_SIZE; size *= 2) {
    const half = size / 2;
    const step = (-2 * Math.PI) / size;
    for (let start = 0; start < FFT_SIZE; start += size) {
      for (let k = 0; k < half; k++) {
        const cos = Math.cos(step * k), sin = Math.sin(step * k);
        const a = start + k, b = a + half;
        const tr = re[b] * cos - im[b] * sin;
        const ti = re[b] * sin + im[b] * cos;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

/** 16 kHz mono audio in [-1, 1] → features of shape [frames, 80], mean-normalised per band. */
export function kaldiFbank(audio: Float32Array): { data: Float32Array; frames: number } {
  const frames = audio.length >= FRAME_LENGTH ? 1 + Math.floor((audio.length - FRAME_LENGTH) / FRAME_SHIFT) : 0;
  const out = new Float32Array(frames * NUM_BINS);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const frame = new Float64Array(FRAME_LENGTH);

  for (let f = 0; f < frames; f++) {
    // Frame, remove DC offset, pre-emphasis, window
    let mean = 0;
    for (let i = 0; i < FRAME_LENGTH; i++) {
      frame[i] = audio[f * FRAME_SHIFT + i] * WAVEFORM_SCALE;
      mean += frame[i];
    }
    mean /= FRAME_LENGTH;
    for (let i = 0; i < FRAME_LENGTH; i++) frame[i] -= mean;
    for (let i = FRAME_LENGTH - 1; i > 0; i--) frame[i] -= PREEMPHASIS * frame[i - 1];
    frame[0] -= PREEMPHASIS * frame[0];
    re.fill(0); im.fill(0);
    for (let i = 0; i < FRAME_LENGTH; i++) re[i] = frame[i] * WINDOW[i];

    // Power spectrum → Mel band energies → log
    fft(re, im);
    for (let b = 0; b < NUM_BINS; b++) {
      const { first, weights } = MEL_BANKS[b];
      let energy = 0;
      for (let k = 0; k < weights.length; k++) {
        const bin = first + k;
        energy += weights[k] * (re[bin] * re[bin] + im[bin] * im[bin]);
      }
      out[f * NUM_BINS + b] = Math.log(Math.max(energy, EPSILON));
    }
  }

  // Subtract each band's mean over the clip
  for (let b = 0; b < NUM_BINS; b++) {
    let mean = 0;
    for (let f = 0; f < frames; f++) mean += out[f * NUM_BINS + b];
    mean /= frames || 1;
    for (let f = 0; f < frames; f++) out[f * NUM_BINS + b] -= mean;
  }
  return { data: out, frames };
}
