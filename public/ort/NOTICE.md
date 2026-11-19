# ONNX Runtime Web: license notice

`ort-wasm-simd-threaded.jsep.mjs` and `ort-wasm-simd-threaded.jsep.wasm` in this folder are copied unmodified from
`node_modules/@huggingface/transformers/dist/` (ONNX Runtime Web, bundled with Transformers.js).
They are served from here because Transformers.js otherwise downloads them from the jsDelivr CDN (`env.backends.onnx.wasm.wasmPaths = '/ort/'` in both workers).

- ONNX Runtime by Microsoft: [MIT License](https://github.com/microsoft/onnxruntime/blob/main/LICENSE).

**After upgrading `@huggingface/transformers`, copy both files again**, or the app may load a runtime that doesn't match the library.
