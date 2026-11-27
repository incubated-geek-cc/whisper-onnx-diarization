# Models folder

The app runs fully offline and loads its models from this folder (`/models/` at runtime). Each model lives in `<owner>/<model name>/`:

```
models/
├── Xenova/
│   ├── whisper-tiny.en/       Transcript only: default, fastest
│   ├── whisper-base.en/       Transcript only: more accurate, English only
│   └── whisper-base/          Transcript only: multilingual
│       ├── config.json, generation_config.json, preprocessor_config.json
│       ├── tokenizer.json, tokenizer_config.json, vocab.json, merges.txt, ...
│       └── onnx/
│           ├── encoder_model_fp16.onnx
│           └── decoder_model_merged_fp16.onnx
└── onnx-community/
    ├── whisper-base_timestamped/      Transcript + speakers: words with timestamps
    │   ├── config.json, tokenizer.json, ...
    │   └── onnx/
    │       ├── encoder_model.onnx                  (WebGPU)
    │       ├── decoder_model_merged_q4.onnx        (WebGPU)
    │       ├── encoder_model_quantized.onnx        (WASM fallback)
    │       └── decoder_model_merged_quantized.onnx (WASM fallback)
    └── pyannote-segmentation-3.0/     Transcript + speakers: who speaks when
        ├── config.json, preprocessor_config.json
        └── onnx/
            └── model.onnx
FredrikKarlssonSpeech/
└── pyannote-speaker-diarization-onnx/ Transcript + speakers: voiceprints (WeSpeaker ResNet34)
    └── embedding/
        └── model.onnx                 (fp32; input = fbank features from src/workers/kaldi-fbank.ts)
```

Only these `.onnx` files are loaded. The other variants Hugging Face publishes (`_fp16`, `_int8`, `_bnb4`, `decoder_with_past_model`, ...) are not needed.

## Get the models

From the project root:

```bash
npm run models
```

This runs [`scripts/download-models.ps1`](../../scripts/download-models.ps1). It first checks this folder **without using the network**. If every file is here, it stops. Otherwise it downloads only the missing files from Hugging Face, checks each model file against its published SHA-256, and moves it into place once it is complete.

- Check only, download nothing: `powershell -ExecutionPolicy Bypass -File scripts/download-models.ps1 -CheckOnly`
- Some models only: `... -Models whisper-tiny.en,pyannote-segmentation-3.0`
- Download everything again: `... -Force`
- Behind a firewall: set `HF_ENDPOINT` to a Hugging Face mirror first.
- Windows works with the built-in PowerShell. macOS / Linux need [PowerShell 7](https://learn.microsoft.com/powershell/scripting/install/installing-powershell) (`pwsh`).

Then run `npm run build` and `npm run preview`. Download the models before building, because the build copies this folder into `dist`.

## Keeping a copy in a private Backblaze B2 bucket

`npm run models:upload` copies these files to the bucket set in `.env` (see `.env.example`). `npm run models:fetch` (used by the Render build) copies them back into this folder, again only the missing ones. See the main README, section *Hosting the models in a private Backblaze B2 bucket*.

## License

The models are not covered by this project's MIT license. See [`NOTICE.md`](NOTICE.md) and [`LICENSE`](LICENSE).

## Cloned with git?

Large `.onnx` files may be stored with Git LFS. Without `git lfs pull` they are tiny placeholder files and the app fails to load them. `npm run models` treats placeholders as missing and replaces them.
