/**
 * 关键词 BM25 与字符向量的混合检索，再用查询词覆盖率重排。
 * 向量是本机的特征哈希，不另起数据库，也不把讲义送去外部嵌入接口。
 */
import type { LectureChunk } from "./corpus";

const DIM = 256;
const RRF_K = 60;

export interface RankedChunk {
  chunk: LectureChunk;
  score: number;
}

interface Prepared {
  chunks: LectureChunk[];
  df: Map<string, number>;
  idf: Map<string, number>;
  avgLen: number;
  postings: Map<string, { index: number; tf: number }[]>;
  docLen: number[];
  vectors: Float32Array[];
}

const preparedCache = new Map<string, Prepared>();

export function termsOf(text: string): string[] {
  const lower = text.toLowerCase().replace(/什么|怎么|如何|哪些|哪个|一下|吗|呢|的/g, " ");
  const out: string[] = [];
  const runs = lower.match(/[\u4e00-\u9fff]+/g) ?? [];
  for (const run of runs) {
    if (run.length >= 2 && run.length <= 8) out.push(run);
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  }
  const words = lower.match(/[a-z0-9][a-z0-9.+-]{1,}/g) ?? [];
  for (const word of words) {
    if (!/^(on|of|the|and|to|in|for|an|is|are|with|from|by|or|at)$/.test(word)) out.push(word);
  }
  return out;
}

/** 向量通道多用单字，好让「权重」和「熵权法」仍有重叠。 */
function vectorTerms(text: string): string[] {
  const base = termsOf(text);
  const chars = text.toLowerCase().match(/[\u4e00-\u9fff]/g) ?? [];
  return base.concat(chars);
}

function hashTerm(token: string): number {
  let h = 2166136261;
  for (let i = 0; i < token.length; i++) h = Math.imul(h ^ token.charCodeAt(i), 16777619);
  return h >>> 0;
}

function embed(tokens: string[], idf: Map<string, number>): Float32Array {
  const v = new Float32Array(DIM);
  for (const token of tokens) {
    const h = hashTerm(token);
    const sign = h & 1 ? 1 : -1;
    v[(h >>> 1) % DIM] += sign * (idf.get(token) ?? 1);
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) v[i] /= norm;
  return v;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < DIM; i++) s += a[i] * b[i];
  return s;
}

function buildIndex(chunks: LectureChunk[]): Prepared {
  const df = new Map<string, number>();
  const docTerms: string[][] = [];
  let lenSum = 0;
  for (const chunk of chunks) {
    const tokens = termsOf(`${chunk.docTitle}\n${chunk.heading}\n${chunk.body}`);
    docTerms.push(tokens);
    lenSum += tokens.length;
    for (const token of new Set(tokens)) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const n = Math.max(chunks.length, 1);
  const idf = new Map<string, number>();
  for (const [token, freq] of df) idf.set(token, Math.log(1 + (n - freq + 0.5) / (freq + 0.5)));
  const postings = new Map<string, { index: number; tf: number }[]>();
  const docLen: number[] = [];
  const vectors: Float32Array[] = [];
  chunks.forEach((chunk, index) => {
    const tokens = docTerms[index];
    docLen.push(tokens.length);
    const tf = new Map<string, number>();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    for (const [token, count] of tf) {
      const list = postings.get(token) ?? [];
      list.push({ index, tf: count });
      postings.set(token, list);
    }
    vectors.push(embed(vectorTerms(`${chunk.docTitle}\n${chunk.heading}\n${chunk.body}`), idf));
  });
  return { chunks, df, idf, avgLen: lenSum / n || 1, postings, docLen, vectors };
}

function indexFor(chunks: LectureChunk[], stamp: string): Prepared {
  const hit = preparedCache.get(stamp);
  if (hit) return hit;
  const built = buildIndex(chunks);
  preparedCache.set(stamp, built);
  return built;
}

function bm25(query: string[], index: Prepared): Map<number, number> {
  const scores = new Map<number, number>();
  const k1 = 1.2;
  const b = 0.75;
  for (const token of new Set(query)) {
    const list = index.postings.get(token);
    if (!list) continue;
    const idf = index.idf.get(token) ?? 0;
    for (const hit of list) {
      const lenNorm = 1 - b + b * (index.docLen[hit.index] / index.avgLen);
      const part = idf * ((hit.tf * (k1 + 1)) / (hit.tf + k1 * lenNorm));
      scores.set(hit.index, (scores.get(hit.index) ?? 0) + part);
    }
  }
  return scores;
}

function coverage(query: string[], text: string, index: Prepared): number {
  const n = Math.max(index.chunks.length, 1);
  const unique = [...new Set(query)].filter((token) => (index.df.get(token) ?? 0) / n < 0.5);
  if (unique.length === 0) return 0;
  const hay = text.toLowerCase();
  // 只要求较长的英文或数字原样出现。中文整词对不上时仍靠二字词计算覆盖率。
  const missingLong = unique.some((token) => token.length >= 5 && !/[\u4e00-\u9fff]/.test(token) && !hay.includes(token));
  if (missingLong) return 0;
  let hit = 0;
  let all = 0;
  for (const token of unique) {
    const known = index.idf.get(token);
    const w = known ?? Math.log(1 + n) * 4;
    all += w;
    if (hay.includes(token)) hit += w;
  }
  return all > 0 ? hit / all : 0;
}

/** 混合排序。索引按全库只建一份。allow 用来把结果限制在已选讲次里。 */
export function hybridRank(
  chunks: LectureChunk[],
  stamp: string,
  queryText: string,
  limit: number,
  allow?: (chunk: LectureChunk) => boolean,
): RankedChunk[] {
  if (chunks.length === 0) return [];
  const prepared = indexFor(chunks, stamp);
  const query = termsOf(queryText);
  if (query.length === 0) return [];
  const lexical = bm25(query, prepared);
  const qv = embed(vectorTerms(queryText), prepared.idf);
  const vectorScores: { index: number; score: number }[] = [];
  for (let i = 0; i < prepared.vectors.length; i++) {
    const score = cosine(qv, prepared.vectors[i]);
    if (score > 0) vectorScores.push({ index: i, score });
  }
  const lexRank = [...lexical.entries()].sort((a, b) => b[1] - a[1]).map(([index]) => index);
  const vecRank = vectorScores.sort((a, b) => b.score - a.score).map((hit) => hit.index);
  const fused = new Map<number, number>();
  lexRank.forEach((index, rank) => fused.set(index, (fused.get(index) ?? 0) + 1 / (RRF_K + rank + 1)));
  vecRank.slice(0, 40).forEach((index, rank) => fused.set(index, (fused.get(index) ?? 0) + 1 / (RRF_K + rank + 1)));
  const reranked = [...fused.entries()]
    .map(([index, rrf]) => {
      const chunk = prepared.chunks[index];
      const cover = coverage(query, `${chunk.docTitle}\n${chunk.heading}\n${chunk.body}`, prepared);
      const titleBoost = chunk.docTitle.toLowerCase().includes(query[0]) ? 0.04 : 0;
      return { index, score: rrf * (0.25 + cover) + titleBoost, cover };
    })
    .filter((hit) => hit.cover >= 0.18 && (!allow || allow(prepared.chunks[hit.index])))
    .sort((a, b) => b.score - a.score);
  if (reranked.length === 0 || reranked[0].cover < 0.18) return [];
  return reranked.slice(0, limit).map((hit) => ({ chunk: prepared!.chunks[hit.index], score: hit.score }));
}
