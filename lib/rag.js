// Retrieval-augmented generation: chunk documents, embed them, and find the
// passages most relevant to a question. Stored in memory per browser session
// (a restart clears it).
//
// Every entry point takes an `embedder` (see lib/providers). Vectors are only
// comparable within the model that produced them, so the store is partitioned
// by embedder id: two agents on different embedding models keep separate
// document sets rather than silently scoring across incompatible vectors.
import { randomUUID } from 'node:crypto';

const CHUNK_CHARS = 900;
const CHUNK_OVERLAP = 150;
const MAX_DOCS_PER_SESSION = 20;
const MAX_CHUNKS_PER_DOC = 400;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

const sessions = new Map(); // `${sessionId}::${embedder.id}` -> { docs: Doc[], touched }

const keyFor = (sessionId, embedder) => `${sessionId}::${embedder.id}`;

function session(sessionId, embedder) {
  const key = keyFor(sessionId, embedder);
  let s = sessions.get(key);
  if (!s) sessions.set(key, (s = { docs: [], touched: Date.now() }));
  s.touched = Date.now();
  return s;
}

setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) if (s.touched < cutoff) sessions.delete(id);
}, 60 * 60 * 1000).unref();

/** Split text into overlapping chunks, preferring paragraph and sentence boundaries. */
export function chunkText(text, size = CHUNK_CHARS, overlap = CHUNK_OVERLAP) {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + size);
    if (end < clean.length) {
      const window = clean.slice(start + size * 0.5, end);
      const para = window.lastIndexOf('\n\n');
      const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
      const cut = para >= 0 ? para : sentence >= 0 ? sentence + 1 : -1;
      if (cut >= 0) end = start + size * 0.5 + cut + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece.length > 40) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Rank arbitrary passages against a query (used for web results). */
export async function rankPassages(embedder, query, passages, k = 4) {
  if (!passages.length) return [];
  const [[q], vecs] = await Promise.all([embedder.embed([query], 'query'), embedder.embed(passages.map((p) => p.text))]);
  return passages
    .map((p, i) => ({ ...p, score: dot(q, vecs[i]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

export async function addDocument(embedder, sessionId, { title, text, source, type }) {
  const s = session(sessionId, embedder);
  if (s.docs.length >= MAX_DOCS_PER_SESSION) throw new Error(`You can share up to ${MAX_DOCS_PER_SESSION} documents.`);
  const existing = source && s.docs.find((d) => d.source === source);
  if (existing) return summary(existing);

  const pieces = chunkText(text).slice(0, MAX_CHUNKS_PER_DOC);
  if (!pieces.length) throw new Error('No readable text found in that document.');
  const vectors = await embedder.embed(pieces.map((p) => `${title}\n${p}`));
  const doc = {
    id: randomUUID(),
    title: title || 'Untitled',
    source: source || null,
    type,
    chars: text.length,
    chunks: pieces.map((t, i) => ({ text: t, vec: vectors[i] })),
    added: Date.now(),
  };
  s.docs.push(doc);
  return summary(doc);
}

function summary(d) {
  return { id: d.id, title: d.title, source: d.source, type: d.type, chunks: d.chunks.length, chars: d.chars };
}

export function listDocuments(embedder, sessionId) {
  const s = sessions.get(keyFor(sessionId, embedder));
  return s ? s.docs.map(summary) : [];
}

export function removeDocument(embedder, sessionId, docId) {
  const s = sessions.get(keyFor(sessionId, embedder));
  if (!s) return false;
  const before = s.docs.length;
  s.docs = s.docs.filter((d) => d.id !== docId);
  return s.docs.length < before;
}

export function hasDocuments(embedder, sessionId) {
  return (sessions.get(keyFor(sessionId, embedder))?.docs.length || 0) > 0;
}

/** Top-k passages across the session's documents: [{ title, source, text, score }]. */
export async function searchDocuments(embedder, sessionId, query, k = 4) {
  const s = sessions.get(keyFor(sessionId, embedder));
  if (!s?.docs.length) return [];
  const [q] = await embedder.embed([query], 'query');
  const scored = [];
  for (const d of s.docs) for (const c of d.chunks) scored.push({ title: d.title, source: d.source, text: c.text, score: dot(q, c.vec) });
  return scored.sort((a, b) => b.score - a.score).slice(0, k);
}
