import type { ModelConfig } from '@/types/whisper';

// Models for normal transcription. Files live in public/models/<path>/
export const DEFAULT_MODELS: Record<string, ModelConfig> = {
  'whisper-tiny.en': {
    name: 'Whisper Tiny (English)',
    path: 'Xenova/whisper-tiny.en',
    quantized: true,
    dtype: 'fp16'
  },
  'whisper-base.en': {
    name: 'Whisper Base (English)',
    path: 'Xenova/whisper-base.en',
    quantized: true,
    dtype: 'fp16'
  },
  'whisper-base': {
    name: 'Whisper Base (Multilingual)',
    path: 'Xenova/whisper-base',
    is_multilingual: true,
    quantized: true,
    dtype: 'fp16'
  }
};

export const DEFAULT_MODEL_KEY = 'whisper-tiny.en';
