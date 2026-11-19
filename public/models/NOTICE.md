# Model credits and licenses

The models used by this app are **not** part of this project's MIT license. They are downloaded and redistributed unmodified under their own licenses, listed below.

| Folder | Used by | ONNX weights | Original model | License |
|---|---|---|---|---|
| `Xenova/whisper-tiny.en` | Transcript only (default) | [Xenova/whisper-tiny.en](https://huggingface.co/Xenova/whisper-tiny.en) | [openai/whisper-tiny.en](https://huggingface.co/openai/whisper-tiny.en) | Apache-2.0 |
| `Xenova/whisper-base.en` | Transcript only | [Xenova/whisper-base.en](https://huggingface.co/Xenova/whisper-base.en) | [openai/whisper-base.en](https://huggingface.co/openai/whisper-base.en) | Apache-2.0 |
| `Xenova/whisper-base` | Transcript only | [Xenova/whisper-base](https://huggingface.co/Xenova/whisper-base) | [openai/whisper-base](https://huggingface.co/openai/whisper-base) | Apache-2.0 |
| `onnx-community/whisper-base_timestamped` | Transcript + speakers | [onnx-community/whisper-base_timestamped](https://huggingface.co/onnx-community/whisper-base_timestamped) | [openai/whisper-base](https://huggingface.co/openai/whisper-base) | Apache-2.0 (the license of the original model; the ONNX model card does not state one) |
| `onnx-community/pyannote-segmentation-3.0` | Transcript + speakers | [onnx-community/pyannote-segmentation-3.0](https://huggingface.co/onnx-community/pyannote-segmentation-3.0) | [pyannote/segmentation-3.0](https://huggingface.co/pyannote/segmentation-3.0) | MIT |
| `Xenova/wavlm-base-plus-sv` | Transcript + speakers (voiceprints) | [Xenova/wavlm-base-plus-sv](https://huggingface.co/Xenova/wavlm-base-plus-sv) | [microsoft/wavlm-base-plus-sv](https://huggingface.co/microsoft/wavlm-base-plus-sv) | CC BY-SA 3.0 (per the model card's link to [microsoft/UniSpeech](https://github.com/microsoft/UniSpeech/blob/main/LICENSE)) |

- **Whisper** was created by OpenAI and introduced in *Robust Speech Recognition via Large-Scale Weak Supervision* (Radford et al., 2022, [arXiv:2212.04356](https://arxiv.org/abs/2212.04356)). The Apache-2.0 text is in [`LICENSE`](LICENSE) in this folder.
- **pyannote segmentation-3.0** was created by Hervé Bredin and the pyannote team ([pyannote-audio](https://github.com/pyannote/pyannote-audio)). The original is gated on Hugging Face; this app uses the ungated ONNX conversion, which needs no token.
- **WavLM** was created by Microsoft (Chen et al., *WavLM: Large-Scale Self-Supervised Pre-Training for Full Stack Speech Processing*, [arXiv:2110.13900](https://arxiv.org/abs/2110.13900)); the `-sv` version is fine-tuned for speaker verification. Its license, CC BY-SA 3.0, requires attribution and that changed versions are shared under the same license; this app redistributes it unmodified.
- **ONNX conversions** are by Xenova (Joshua Lochner) and the onnx-community organisation for [Transformers.js](https://huggingface.co/docs/transformers.js), published on the Hugging Face Hub.
