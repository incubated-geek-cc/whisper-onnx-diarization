# FFmpeg core: license notice

`ffmpeg-core.js` and `ffmpeg-core.wasm` in this folder are copied unmodified from the npm package
[`@ffmpeg/core@0.12.9`](https://www.npmjs.com/package/@ffmpeg/core/v/0.12.9) (`node_modules/@ffmpeg/core/dist/esm/`).
They are served from here so the app never loads FFmpeg from a CDN.

- License: **GPL-2.0-or-later** (as declared by `@ffmpeg/core`). These two files are **not** covered by this project's MIT license.
- Source code: [ffmpegwasm/ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) (core build scripts) and [FFmpeg](https://ffmpeg.org/download.html).
- License text: [GNU GPL v2](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html).

The JavaScript wrappers `@ffmpeg/ffmpeg` and `@ffmpeg/util`, installed with `npm install`, are MIT-licensed.

To update: install the new `@ffmpeg/core` version and copy both files from `node_modules/@ffmpeg/core/dist/esm/` into this folder again.
