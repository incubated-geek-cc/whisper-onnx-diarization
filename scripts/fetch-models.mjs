// Fetches the required model files from the PRIVATE Backblaze B2 bucket into public/models.
// Used by the Render build (npm run models:fetch) so the models don't have to live in git.
//
// For each file in scripts/models-manifest.json:
//   already in public/models (not empty, not a Git LFS placeholder)  -> skip
//   otherwise                                                         -> download from the bucket
//
// Settings: B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET (and optional B2_PREFIX, default "models"),
// from environment variables (Render) or the project's .env file (your PC). A read-only key is enough.
// Signs in with the B2 native API (b2_authorize_account), then downloads by file name with the token.
// Plain Node 20+, no packages needed.
//
//   node scripts/fetch-models.mjs            download what is missing
//   node scripts/fetch-models.mjs --check    report only (no network), exit 1 if anything is missing
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.join(scriptsDir, '..');
const modelsDir = path.join(projectDir, 'public', 'models');
const checkOnly = process.argv.includes('--check');
const AUTH_URL = process.env.B2_AUTH_URL || 'https://api.backblazeb2.com/b2api/v3/b2_authorize_account';

// .env values (if the file exists); real environment variables win
function readDotEnv() {
  const file = path.join(projectDir, '.env');
  const values = {};
  if (!existsSync(file)) return values;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const at = trimmed.indexOf('=');
    values[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim().replace(/^["']|["']$/g, '');
  }
  return values;
}
const dotenv = readDotEnv();
const setting = (name, fallback = '') => process.env[name] || dotenv[name] || fallback;

const keyId = setting('B2_KEY_ID');
const appKey = setting('B2_APPLICATION_KEY');
const bucket = setting('B2_BUCKET');
const prefix = setting('B2_PREFIX', 'models').replace(/^\/+|\/+$/g, '');

const manifest = JSON.parse(await readFile(path.join(scriptsDir, 'models-manifest.json'), 'utf8'));

const formatSize = (bytes) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;

// Present = exists, not empty, and not a Git LFS pointer
async function isPresent(file) {
  try {
    const { size } = await stat(file);
    if (size === 0) return false;
    if (size < 1024) {
      const handle = await open(file, 'r');
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(64), 0, 64, 0);
      await handle.close();
      if (buffer.subarray(0, bytesRead).toString('utf8').startsWith('version https://git-lfs')) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// Sign in once: returns the download base URL and a token (valid 24 h)
async function authorize() {
  const res = await fetch(AUTH_URL, {
    headers: { Authorization: `Basic ${Buffer.from(`${keyId}:${appKey}`).toString('base64')}` }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`B2 sign-in failed (HTTP ${res.status}): ${body.message || body.code || 'check B2_KEY_ID / B2_APPLICATION_KEY'}`);
  const downloadUrl = body.apiInfo?.storageApi?.downloadUrl ?? body.downloadUrl;   // v3, or v2 shape
  if (!body.authorizationToken || !downloadUrl) throw new Error('B2 sign-in returned no token or download URL');
  return { token: body.authorizationToken, downloadUrl: downloadUrl.replace(/\/+$/, '') };
}

async function download(url, token, target) {
  await mkdir(path.dirname(target), { recursive: true });
  const part = `${target}.part`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { Authorization: token } });
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});   // free the connection
        if ([401, 403, 404].includes(res.status)) {
          attempt = 3;                              // retrying won't help
          throw new Error(`HTTP ${res.status}: ${res.status === 404 ? 'not in the bucket (run npm run models:upload)' : 'key has no read access to this bucket'}`);
        }
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const expected = Number(res.headers.get('content-length')) || 0;
      await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
      const { size } = await stat(part);
      if (expected && size !== expected) throw new Error(`size mismatch: expected ${expected} bytes, got ${size}`);
      await rename(part, target);
      return size;
    } catch (err) {
      await rm(part, { force: true });
      if (attempt >= 3) throw err;
      console.log(`    retry ${attempt} (${err.message})`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

// Step 1: what is already here (no network)
console.log(`Whisper ONNX models (source: private B2 bucket "${bucket || '?'}/${prefix}")`);
const missing = [];
for (const model of manifest.models) {
  const need = [];
  for (const file of model.files) {
    if (!(await isPresent(path.join(modelsDir, model.id, file)))) need.push(file);
  }
  if (need.length === 0) {
    console.log(`  [ok]      ${model.id}  (${model.files.length}/${model.files.length} files)`);
  } else {
    console.log(`  [missing] ${model.id}  (${need.length} of ${model.files.length} files)`);
    if (checkOnly) need.forEach((f) => console.log(`            - ${f}`));
    need.forEach((file) => missing.push({ id: model.id, file }));
  }
}

if (missing.length === 0) {
  console.log('All model files are present. Nothing to download.');
  process.exit(0);
}
if (checkOnly) {
  console.log(`${missing.length} file(s) missing.`);
  process.exit(1);
}

// Step 2: sign in and download only the missing files
const unset = Object.entries({ B2_KEY_ID: keyId, B2_APPLICATION_KEY: appKey, B2_BUCKET: bucket })
  .filter(([, v]) => !v || v.includes('REPLACE'))
  .map(([k]) => k);
if (unset.length) {
  console.error(`Set ${unset.join(', ')} (in .env on your PC, or under Environment on Render).`);
  process.exit(1);
}

let auth;
try {
  auth = await authorize();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

let downloaded = 0;
const failed = [];
for (const { id, file } of missing) {
  const name = `${prefix}/${id}/${file}`.split('/').map(encodeURIComponent).join('/');
  const url = `${auth.downloadUrl}/file/${encodeURIComponent(bucket)}/${name}`;
  try {
    const size = await download(url, auth.token, path.join(modelsDir, id, file));
    downloaded += size;
    console.log(`    [get]  ${id}/${file}  (${formatSize(size)})`);
  } catch (err) {
    console.error(`    [fail] ${id}/${file}: ${err.message}`);
    failed.push(`${id}/${file}`);
  }
}

console.log(`Downloaded ${formatSize(downloaded)}.`);
if (failed.length) {
  console.error(`Failed: ${failed.length} file(s).`);
  process.exit(1);
}
