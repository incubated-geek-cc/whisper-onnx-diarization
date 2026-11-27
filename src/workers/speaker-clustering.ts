// Groups voiceprints (speaker embeddings) into speakers.
//
// Average-linkage agglomerative clustering on cosine similarity:
//   start with every voiceprint as its own group, then keep merging the two most similar groups
//   (similarity of two groups = average similarity of all their pairs) until either
//   - the most similar pair is below `threshold`        (number of speakers unknown), or
//   - only `numSpeakers` groups are left                 (number of speakers given by the user).
//
// Voiceprints of voices that pyannote heard in the same window are different people by definition
// (pyannote already told them apart), so they are not merged ("cannot-link").
// Exception: if the user gave numSpeakers and only such pairs are left, the user's number wins
// and the most similar pair is merged anyway (pyannote sometimes splits one voice in two).

export interface ClusterOptions {
  threshold: number;        // cosine similarity needed to merge when numSpeakers is not given
  numSpeakers?: number;     // exact number of speakers, if known
}

function normalise(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/**
 * @param embeddings one voiceprint per item
 * @param apart      pairs of items that must never be merged (heard in the same window)
 * @returns          speaker number per item, numbered 0, 1, 2… in order of first appearance
 */
export function clusterVoiceprints(embeddings: Float32Array[], apart: [number, number][], options: ClusterOptions): number[] {
  const n = embeddings.length;
  if (n === 0) return [];
  const vectors = embeddings.map(normalise);
  const mustSplit = new Set(apart.map(([i, j]) => (i < j ? i * n + j : j * n + i)));

  // Pairwise similarity. `sim` has -Infinity for must-stay-apart pairs; `raw` ignores that rule.
  const sim: Float64Array[] = Array.from({ length: n }, () => new Float64Array(n));
  const raw: Float64Array[] = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      let s = 0;
      const a = vectors[i], b = vectors[j];
      for (let d = 0; d < a.length; d++) s += a[d] * b[d];
      raw[i][j] = raw[j][i] = s;
      sim[i][j] = sim[j][i] = mustSplit.has(i * n + j) ? -Infinity : s;
    }
  }

  const active = new Array<boolean>(n).fill(true);
  const size = new Array<number>(n).fill(1);
  const owner = Array.from({ length: n }, (_, i) => i);   // item -> group it currently belongs to
  let count = n;
  const target = options.numSpeakers && options.numSpeakers > 0 ? options.numSpeakers : 0;

  const mostSimilar = (m: Float64Array[]) => {
    let best = -Infinity, bi = -1, bj = -1;
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (active[j] && m[i][j] > best) { best = m[i][j]; bi = i; bj = j; }
      }
    }
    return { best, bi, bj };
  };

  while (count > 1) {
    if (target && count <= target) break;
    let { best, bi, bj } = mostSimilar(sim);
    if (best === -Infinity) {
      if (!target) break;                              // only must-stay-apart pairs left
      ({ best, bi, bj } = mostSimilar(raw));           // user's number wins
    }
    if (bi < 0) break;
    if (!target && best < options.threshold) break;

    // Merge group bj into bi; new similarity to every other group = size-weighted average
    for (let k = 0; k < n; k++) {
      if (!active[k] || k === bi || k === bj) continue;
      const average = (a: number, b: number) => (a * size[bi] + b * size[bj]) / (size[bi] + size[bj]);
      const a = sim[bi][k], b = sim[bj][k];
      sim[bi][k] = sim[k][bi] = a === -Infinity || b === -Infinity ? -Infinity : average(a, b);
      raw[bi][k] = raw[k][bi] = average(raw[bi][k], raw[bj][k]);
    }
    size[bi] += size[bj];
    active[bj] = false;
    for (let i = 0; i < n; i++) if (owner[i] === bj) owner[i] = bi;
    count--;
  }

  // Number speakers 0, 1, 2… in order of first appearance
  const numbering = new Map<number, number>();
  return owner.map(o => {
    if (!numbering.has(o)) numbering.set(o, numbering.size);
    return numbering.get(o)!;
  });
}
