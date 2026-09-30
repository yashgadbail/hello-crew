// Hello Crew web server: serves the front end from ./public, handles accounts
// and per-user memory (PostgreSQL), runs the persona chat pipeline (Ollama +
// web search + document RAG), and proxies the Python voice service.
import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listAgents, resolveAgent, runtimeFor, publicAgent } from './lib/agents.js';
import { llmFor, embedderFor, DEFAULT_MODEL, DEFAULT_EMBED } from './lib/providers/index.js';
import { respond } from './lib/chat.js';
import { addDocument, listDocuments, removeDocument } from './lib/rag.js';
import { fetchPage } from './lib/web.js';
import { AuthError, signUp, logIn, renameUser, createSession, userFromRequest, endSession, signupMode, seedInvites } from './lib/auth.js';
import { getHistory, addMessage, historyCounts, getMemory, forget, eraseAll, saveStudy, learnFromTurn, memoryNote, greetingFor, useStore } from './lib/memory.js';
import { postgresStore } from './lib/store/postgres.js';
import { ready as dbReady, query } from './lib/db.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TTS_URL = (process.env.TTS_URL || 'http://127.0.0.1:5005').replace(/\/$/, '');
const NCERT_URL = (process.env.NCERT_URL || 'http://127.0.0.1:5006').replace(/\/$/, '');
const ROOT_DIR = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = resolve(ROOT_DIR, 'public');
const MAX_DOC_CHARS = 2_000_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': MIME['.json'] });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function readBody(req, limit = 1_000_000) {
  return readBuffer(req, limit).then((buf) => buf.toString('utf8'));
}

function readBuffer(req, limit) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  try {
    return JSON.parse(await readBody(req, limit));
  } catch {
    return null;
  }
}

// Shared documents (RAG) are kept per user.
const docsKey = (user) => `user-${user.id}`;

// The server's own providers, for work that is not part of an agent's turn:
// learning from a conversation after it ends, and embedding uploaded documents
// (the upload UI is not tied to a character).
const utilityLlm = llmFor(DEFAULT_MODEL);
const utilityEmbedder = embedderFor(DEFAULT_EMBED);

async function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return sendText(res, 400, 'Bad request');
  }
  if (pathname.endsWith('/')) pathname += 'index.html';

  const file = resolve(PUBLIC_DIR, '.' + pathname);
  if (!file.startsWith(PUBLIC_DIR + sep)) return sendText(res, 403, 'Forbidden');

  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    sendText(res, 404, 'Not found');
  }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
async function ttsHealth() {
  try {
    const r = await fetch(`${TTS_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return await r.json();
  } catch {
    return { ok: false };
  }
}

async function ncertHealth() {
  try {
    return await (await fetch(`${NCERT_URL}/health`, { signal: AbortSignal.timeout(2000) })).json();
  } catch {
    return { ok: false };
  }
}

/** The indexed NCERT textbooks: { "10": { "science": [{ chapter, title }] } }, or {} if none. */
async function handleBooks(res) {
  try {
    const r = await fetch(`${NCERT_URL}/catalog`, { signal: AbortSignal.timeout(5000) });
    sendJson(res, 200, { ok: r.ok, catalog: r.ok ? await r.json() : {} });
  } catch {
    sendJson(res, 200, { ok: false, catalog: {} });
  }
}

// The browser re-checks health every time a call starts, so cache the model
// list briefly rather than hitting the provider on each one.
const MODEL_TTL_MS = 30_000;
const modelCache = new Map(); // `${kind}:${baseUrl}` -> { at, names }

async function pulledModels(llm) {
  const key = `${llm.kind}:${llm.baseUrl}`;
  const hit = modelCache.get(key);
  if (hit && Date.now() - hit.at < MODEL_TTL_MS) return hit.names;
  const names = await llm.listModels();
  modelCache.set(key, { at: Date.now(), names });
  return names;
}

/** Ollama reports either "name" or "name:latest". */
const hasModel = (names, m) => names.includes(m) || names.includes(`${m}:latest`);

/** Can this provider answer right now? Never throws. */
async function modelStatus(llm, embedModel) {
  // A hosted provider has nothing to download, so there is nothing to check.
  if (!llm.listModels) return { ok: true, error: null, warning: null, names: [] };
  let names;
  try {
    names = await pulledModels(llm);
  } catch {
    return { ok: false, error: `Can't reach Ollama at ${llm.baseUrl}. Start it with: ollama serve`, warning: null, names: [] };
  }
  if (!hasModel(names, llm.model)) {
    return { ok: false, error: `Model "${llm.model}" isn't downloaded yet. Run: ollama pull ${llm.model}`, warning: null, names };
  }
  const warning = embedModel && !hasModel(names, embedModel) ? `Document search is off until you run: ollama pull ${embedModel}` : null;
  return { ok: true, error: null, warning, names };
}

/** Public: can this server hold a call at all? Reports only its own defaults. */
async function handleHealth(res) {
  const [tts, ncert, models] = await Promise.all([ttsHealth(), ncertHealth(), modelStatus(utilityLlm, utilityEmbedder.model)]);
  sendJson(res, 200, { ok: models.ok, tts, ncert, error: models.error, warning: models.warning });
}

/** Authed: can THIS agent answer, on the model it is configured to use? */
async function handleAgentHealth(res, agentId) {
  const agent = resolveAgent(agentId);
  if (!agent) return sendText(res, 404, 'Unknown agent');
  const { llm, embedder } = runtimeFor(agent);
  const { ok, error, warning, names } = await modelStatus(llm, embedder.model);
  sendJson(res, 200, { ok, error, warning, provider: llm.kind, model: llm.model, pulled: hasModel(names, llm.model) });
}

// ---------------------------------------------------------------------------
// Chat: newline-delimited JSON events (see lib/chat.js)
// ---------------------------------------------------------------------------
async function handleChat(req, res, user) {
  const body = await readJson(req);
  if (!body) return sendText(res, 400, 'Invalid JSON body');
  const agent = resolveAgent(body.persona);
  if (!agent) return sendText(res, 400, 'Unknown persona');
  const messages = (Array.isArray(body.messages) ? body.messages : []).filter(
    (m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim(),
  );
  if (messages.at(-1)?.role !== 'user') return sendText(res, 400, 'The last message must be from the user');

  const question = messages.at(-1).content;
  const memory = await getMemory(user.id);
  await addMessage(user.id, agent.id, 'user', question);
  const { llm, embedder } = runtimeFor(agent);

  const controller = new AbortController();
  res.on('close', () => controller.abort());
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  let reply = '';
  try {
    const events = respond({
      agent,
      messages,
      sessionId: docsKey(user),
      llm,
      embedder,
      userNote: memoryNote(user, memory, agent),
      study: agent.ncert ? memory.study : null,
      signal: controller.signal,
    });
    for await (const event of events) {
      if (controller.signal.aborted) break;
      if (event.type === 'text') reply += event.text;
      if (event.type === 'study') await saveStudy(user.id, event);
      res.write(JSON.stringify(event) + '\n');
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error('Chat error:', err.message);
      res.write(JSON.stringify({ type: 'error', text: err.message }) + '\n');
    }
  }
  // Decide this before res.end(): the socket's 'close' fires right after and
  // would make a finished reply look interrupted.
  const interrupted = controller.signal.aborted;
  res.end();
  if (reply.trim()) {
    await addMessage(user.id, agent.id, 'assistant', interrupted ? `${reply}…` : reply);
    if (!interrupted) learnFromTurn(user.id, question, utilityLlm);
  }
}

// ---------------------------------------------------------------------------
// Accounts and memory
// ---------------------------------------------------------------------------
const isSecure = (req) => !!useHttps || req.headers['x-forwarded-proto'] === 'https';

/** The visitor's IP. Tunnels (cloudflared, Tailscale, ngrok) connect from this machine and
 *  pass the real address in a header; only trust that header when the request is local. */
function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  if (/^(::1|127\.|::ffff:127\.)/.test(remote)) {
    const forwarded = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return remote;
}

async function handleAuth(req, res, action) {
  if (action === 'me' && req.method === 'GET') {
    return sendJson(res, 200, { user: await userFromRequest(req), signupMode: await signupMode() });
  }
  if (req.method !== 'POST') return sendText(res, 405, 'Method not allowed');
  if (action === 'logout') {
    res.setHeader('Set-Cookie', await endSession(req));
    return sendJson(res, 200, { ok: true });
  }
  const body = (await readJson(req, 10_000)) || {};
  try {
    const user = action === 'signup' ? await signUp(body, clientIp(req)) : action === 'login' ? await logIn(body) : null;
    if (!user) return sendText(res, 404, 'Not found');
    res.setHeader('Set-Cookie', await createSession(user.id, isSecure(req)));
    return sendJson(res, 200, { user });
  } catch (err) {
    if (err instanceof AuthError) return sendJson(res, err.status, { error: err.message });
    throw err;
  }
}

/** A call is starting: the history with this character and a personal greeting. */
async function handleCallStart(res, user, url) {
  const agent = resolveAgent(url.searchParams.get('persona'));
  if (!agent) return sendText(res, 400, 'Unknown persona');
  const history = await getHistory(user.id, agent.id);
  const greeting = greetingFor(agent, user, await getMemory(user.id), history.length > 0);
  sendJson(res, 200, { history, greeting });
}

async function handleMemory(req, res, user, url) {
  if (req.method === 'GET') {
    return sendJson(res, 200, { user, memory: await getMemory(user.id), history: await historyCounts(user.id) });
  }
  if (req.method === 'DELETE') {
    const fact = url.searchParams.get('fact');
    const field = url.searchParams.get('field');
    if (fact || field) await forget(user.id, { fact, field });
    else await eraseAll(user.id);
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === 'POST') {
    const body = (await readJson(req, 10_000)) || {};
    try {
      return sendJson(res, 200, { user: { ...user, name: await renameUser(user.id, body.name) } });
    } catch (err) {
      if (err instanceof AuthError) return sendJson(res, err.status, { error: err.message });
      throw err;
    }
  }
  sendText(res, 405, 'Method not allowed');
}

// ---------------------------------------------------------------------------
// Documents (RAG): PDFs are parsed in the browser and arrive as text.
// ---------------------------------------------------------------------------
async function handleDocs(req, res, url, user) {
  const session = docsKey(user);
  // Uploads are not tied to a character, so they use the server's embedder. An
  // agent on a different embedding model keeps its own set (see lib/rag.js).
  const embedder = utilityEmbedder;
  if (req.method === 'GET') {
    return sendJson(res, 200, { docs: listDocuments(embedder, session) });
  }
  if (req.method === 'DELETE') {
    return sendJson(res, 200, { removed: removeDocument(embedder, session, url.searchParams.get('id')) });
  }
  if (req.method === 'POST') {
    const body = await readJson(req, 8_000_000);
    if (!body) return sendText(res, 400, 'Invalid request');
    try {
      let doc;
      if (body.url) {
        const page = await fetchPage(body.url);
        doc = await addDocument(embedder, session, { title: page.title, text: page.text, source: page.url, type: 'link' });
      } else if (typeof body.text === 'string' && body.text.trim()) {
        doc = await addDocument(embedder, session, {
          title: String(body.title || 'Document').slice(0, 200),
          text: body.text.slice(0, MAX_DOC_CHARS),
          type: body.type === 'pdf' ? 'pdf' : 'text',
        });
      } else {
        return sendText(res, 400, 'Send either a url or some text');
      }
      return sendJson(res, 200, { doc });
    } catch (err) {
      return sendJson(res, 422, { error: err.message });
    }
  }
  sendText(res, 405, 'Method not allowed');
}

async function handleTts(req, res) {
  let upstream;
  try {
    upstream = await fetch(`${TTS_URL}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: await readBody(req, 20_000),
    });
  } catch {
    return sendText(res, 502, `Can't reach the KittenTTS service at ${TTS_URL}`);
  }
  const audio = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'audio/wav' });
  res.end(audio);
}

// Speech-to-text: the browser sends raw 16 kHz 16-bit PCM of one utterance.
async function handleStt(req, res) {
  let audio;
  try {
    audio = await readBuffer(req, 16000 * 2 * 60);
  } catch {
    return sendText(res, 413, 'Audio too long');
  }
  try {
    const upstream = await fetch(`${TTS_URL}/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: audio,
      signal: AbortSignal.timeout(30000),
    });
    res.writeHead(upstream.status, { 'Content-Type': MIME['.json'] });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    sendJson(res, 502, { error: `Can't reach the speech service at ${TTS_URL}` });
  }
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  try {
    // Liveness for Docker/monitoring: the process is up and the database answers.
    if (pathname === '/healthz') {
      await query('SELECT 1');
      return sendJson(res, 200, { ok: true });
    }
    // Public: sign in/up, and what the landing page needs to render.
    const auth = pathname.match(/^\/api\/auth\/(signup|login|logout|me)$/);
    if (auth) return await handleAuth(req, res, auth[1]);
    if (pathname === '/api/personas' && req.method === 'GET') return sendJson(res, 200, { personas: listAgents().map(publicAgent) });
    if (pathname === '/api/health' && req.method === 'GET') return await handleHealth(res);
    if (pathname === '/api/books' && req.method === 'GET') return await handleBooks(res);

    // Everything else under /api needs a signed-in user.
    if (pathname.startsWith('/api/')) {
      const user = await userFromRequest(req);
      if (!user) return sendJson(res, 401, { error: 'Please sign in.' });
      if (pathname === '/api/chat' && req.method === 'POST') return await handleChat(req, res, user);
      if (pathname === '/api/call' && req.method === 'GET') return await handleCallStart(res, user, url);
      const agentHealth = pathname.match(/^\/api\/agents\/([\w-]+)\/health$/);
      if (agentHealth && req.method === 'GET') return await handleAgentHealth(res, agentHealth[1]);
      if (pathname === '/api/memory') return await handleMemory(req, res, user, url);
      if (pathname === '/api/docs') return await handleDocs(req, res, url, user);
      if (pathname === '/api/tts' && req.method === 'POST') return await handleTts(req, res);
      if (pathname === '/api/stt' && req.method === 'POST') return await handleStt(req, res);
      return sendText(res, 404, 'Not found');
    }
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res);
    sendText(res, 405, 'Method not allowed');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendText(res, 500, 'Internal server error');
    else res.end();
  }
}

// Camera, mic and WebXR need a secure context. localhost counts as secure; for
// a phone on your LAN, provide a certificate via SSL_KEY / SSL_CERT (or use a tunnel).
const useHttps = process.env.SSL_KEY && process.env.SSL_CERT;
const server = useHttps
  ? https.createServer({ key: readFileSync(process.env.SSL_KEY), cert: readFileSync(process.env.SSL_CERT) }, handler)
  : http.createServer(handler);

// The schema must be current before we take requests (Postgres may still be starting).
await dbReady();
useStore(postgresStore());
await seedInvites();
server.listen(PORT, HOST, () => {
  const scheme = useHttps ? 'https' : 'http';
  console.log(`Hello Crew running at ${scheme}://localhost:${PORT}`);
  console.log(`Default model "${utilityLlm.model}" (+ "${utilityEmbedder.model}" for documents) via ${utilityLlm.kind} at ${utilityLlm.baseUrl}`);
  signupMode().then((mode) =>
    console.log(
      { invite: 'Sign-up needs an invite code (manage codes in the admin panel).', open: 'Sign-up is OPEN to anyone who can reach this server (change it in the admin panel).', closed: 'Sign-up is closed (change it in the admin panel).' }[mode],
    ),
  );
});

// Start the Python helpers (KittenTTS voice, NCERT textbook search) alongside
// us if the venv is set up and nothing is already listening on their ports.
const PYTHON = resolve(ROOT_DIR, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
const children = [];
process.on('exit', () => children.forEach((c) => c.kill()));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit());

async function startPythonService({ name, args, healthUrl, env }) {
  if (process.env[`${name.toUpperCase()}_AUTOSTART`] === '0') return;
  try {
    if ((await fetch(healthUrl, { signal: AbortSignal.timeout(1500) })).ok) return; // already running
  } catch {}
  if (!existsSync(PYTHON)) {
    console.log(`[${name}] Python venv not set up (no .venv), so ${name} is off. See README.`);
    return;
  }
  const child = spawn(PYTHON, ['-u', ...args], { cwd: ROOT_DIR, stdio: ['ignore', 'inherit', 'pipe'], env: { ...process.env, ...env } });
  // Library warnings go to stderr; only surface lines that look like real errors.
  child.stderr.on('data', (d) => {
    const text = d.toString();
    if (/error|traceback/i.test(text)) process.stderr.write(`[${name}] ${text}`);
  });
  child.on('exit', (code) => code && console.error(`[${name}] exited with code ${code}`));
  children.push(child);
}

startPythonService({ name: 'tts', args: ['tts_server.py'], healthUrl: `${TTS_URL}/health`, env: { KITTEN_PORT: new URL(TTS_URL).port || '5005' } });
startPythonService({ name: 'ncert', args: ['-m', 'ncert.server'], healthUrl: `${NCERT_URL}/health`, env: { NCERT_PORT: new URL(NCERT_URL).port || '5006' } });
