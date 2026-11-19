import { pipeline, env } from '@huggingface/transformers';
import type { Device, ModelConfig, TranscriptionSegment, WorkerMessage, WorkerResponse } from '@/types/whisper';
import { DEFAULT_MODELS, DEFAULT_MODEL_KEY } from '@/lib/models';

// ── Local files only: models from public/models, ONNX Runtime from public/ort ──
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.localModelPath = '/models/';
env.backends.onnx.wasm.wasmPaths = '/ort/';   // otherwise Transformers.js fetches ORT from the jsDelivr CDN
env.backends.onnx.wasm.numThreads = 1;
env.backends.onnx.wasm.proxy = false;

const SAMPLE_RATE = 16000;
const WINDOW_SEC = 30;    // Whisper hears 30 s at a time
const OVERLAP_SEC = 5;    // each window starts 25 s after the previous one

const post = (response: WorkerResponse) => self.postMessage(response);

// WebGPU exists in the browser AND a GPU adapter is available (it can be blocklisted)
async function detectDevice(): Promise<Device> {
  if (!navigator.gpu) return 'wasm';
  try {
    return (await navigator.gpu.requestAdapter()) ? 'webgpu' : 'wasm';
  } catch {
    return 'wasm';
  }
}

class WhisperPipeline {
  static instance: any = null;
  static currentModel: ModelConfig | null = null;
  static device: Device = 'wasm';

  static async getInstance(modelConfig: ModelConfig, progress_callback?: (data: any) => void): Promise<any> {
    if (this.instance && this.currentModel?.path !== modelConfig.path) {
      this.instance = null;
    }

    if (this.instance === null) {
      const options = { progress_callback, dtype: modelConfig.dtype || 'fp16' };
      const preferred = await detectDevice();
      try {
        // `device` is what actually picks WebGPU in Transformers.js v3
        this.instance = await pipeline('automatic-speech-recognition', modelConfig.path, { ...options, device: preferred });
        this.device = preferred;
      } catch (err) {
        if (preferred !== 'webgpu') throw err;
        console.warn('[Whisper] WebGPU failed, falling back to WASM:', err);
        this.instance = await pipeline('automatic-speech-recognition', modelConfig.path, { ...options, device: 'wasm' });
        this.device = 'wasm';
      }
      this.currentModel = modelConfig;
    }
    return this.instance;
  }

  static reset() {
    this.instance = null;
    this.currentModel = null;
  }
}

let currentModelConfig: ModelConfig = DEFAULT_MODELS[DEFAULT_MODEL_KEY];

async function transcribe(audio: ArrayBuffer, options?: Record<string, any>) {
  const pipe = await WhisperPipeline.getInstance(currentModelConfig);
  post({ type: 'transcribe-start' });

  const audioArray = new Float32Array(audio);
  const windowSize = WINDOW_SEC * SAMPLE_RATE;
  const step = (WINDOW_SEC - OVERLAP_SEC) * SAMPLE_RATE;

  const transcriptionOptions = {
    chunk_length_s: WINDOW_SEC,
    stride_length_s: OVERLAP_SEC,
    return_timestamps: 'segment',
    language: currentModelConfig.language,
    ...options
  };

  const collected: TranscriptionSegment[] = [];
  const totalSec = audioArray.length / SAMPLE_RATE;
  post({ type: 'progress', done: 0, total: totalSec });

  for (let position = 0; position < audioArray.length; position += step) {
    const chunk = audioArray.slice(position, position + windowSize);
    const offsetSec = position / SAMPLE_RATE;

    let result = await pipe(chunk, transcriptionOptions);

    // Empty window (e.g. it opens with music): retry without timestamps,
    // keep the text as one line covering the whole window
    if (!result.text?.trim()) {
      const plain = await pipe(chunk, { ...transcriptionOptions, return_timestamps: false });
      if (plain.text?.trim()) {
        result = {
          text: plain.text,
          chunks: [{ text: plain.text, timestamp: [0, chunk.length / SAMPLE_RATE] }]
        };
      }
    }

    // Shift timestamps from "seconds into this window" to "seconds into the recording"
    for (const seg of result.chunks ?? []) {
      const segment: TranscriptionSegment = {
        text: seg.text,
        timestamp: [seg.timestamp[0] + offsetSec, seg.timestamp[1] + offsetSec]
      };
      post({ type: 'partial', segment });
      collected.push(segment);
    }
    post({ type: 'progress', done: Math.min(offsetSec + WINDOW_SEC, totalSec), total: totalSec });
  }

  post({
    type: 'transcribe-complete',
    result: { text: collected.map(s => s.text).join(' '), chunks: collected }
  });
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : 'Unknown error');

self.addEventListener('message', async (event: MessageEvent<WorkerMessage>) => {
  const { type, modelConfig, audio, options } = event.data;

  if (type === 'configure') {
    if (!modelConfig) return;
    currentModelConfig = modelConfig;
    WhisperPipeline.reset();   // the new model loads on the next 'load'
    post({ type: 'configured', modelConfig: currentModelConfig });

  } else if (type === 'load') {
    try {
      await WhisperPipeline.getInstance(currentModelConfig, (data) => {
        post({ type: 'loading', status: data.status, progress: data.progress || 0, file: data.file || '' });
      });
      post({ type: 'ready', device: WhisperPipeline.device });
    } catch (error) {
      post({ type: 'error', error: `Failed to load model ${currentModelConfig.name}: ${errorText(error)}` });
    }

  } else if (type === 'transcribe') {
    if (!audio) {
      post({ type: 'error', error: 'No audio data provided' });
      return;
    }
    try {
      await transcribe(audio, options);
    } catch (error) {
      post({ type: 'error', error: `Transcription failed: ${errorText(error)}` });
    }

  } else {
    post({ type: 'error', error: `Unknown message type: ${type}` });
  }
});
