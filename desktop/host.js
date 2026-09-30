// The desktop host: the same agent runtime as the cloud server, but running on
// your own machine for one person.
//
// Differences from ../server.js, all deliberate:
//   - No accounts. It binds to 127.0.0.1 and you are the only user, so there is
//     nothing to sign in to and no session cookie.
//   - SQLite instead of PostgreSQL, so nothing has to be installed.
//   - Agents come from disk as well as the built-in cast (see ./agents-store.js).
//
// It serves the existing browser UI in ../public unchanged.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { respond } from '../lib/chat.js';
import { runtimeFor } from '../lib/agents.js';
import { llmFor, embedderFor, DEFAULT_MODEL, DEFAULT_EMBED } from '../lib/providers/index.js';
import { addDocument, listDocuments, removeDocument } from '../lib/rag.js';
import { fetchPage } from '../lib/web.js';
import {
  useStore, getHistory, addMessage, historyCounts, getMemory, forget, eraseAll, saveStudy, learnFromTurn, memoryNote, greetingFor,
} from '../lib/memory.js';
import { sqliteStore } from '../lib/store/sqlite.js';
import { allAgents, findAgent, saveUserAgent, deleteUserAgent } from './agents-store.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = resolve(ROOT, 'public');
const MAX_DOC_CHARS = 2_000_000;

// One machine, one person. The id is only a key for the local database.
const LOCAL_USER = { id: 'me', name: 'You', email: '' };

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
};

const sendJson = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': MIME['.json'] });
  res.end(JSON.stringify(data));
};
const sendText = (res, status, text) => {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
};

function readJson(req, limit = 1_000_000) {
  return new Promise((done) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        done(null);
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        done(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        done(null);
      }
    });
    req.on('error', () => done(null));
  });
}

async function serveStatic(req, res, pathname) {
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

/** Hide the system prompt from the call UI, the way the cloud server does. */
const publicView = ({ prompt, embed, ...rest }) => rest;

export function startHost({ dataDir, port = 3100, host = '127.0.0.1' } = {}) {
  useStore(sqliteStore(join(dataDir, 'hello-crew.db')));

  // Used for work that is not an agent's own turn: learning after a reply, and
  // embedding uploaded documents (uploads are not tied to a character).
  const utilityLlm = llmFor(DEFAULT_MODEL);
  const utilityEmbedder = embedderFor(DEFAULT_EMBED);
  const docsKey = 'local';

  async function handleChat(req, res) {
    const body = await readJson(req);
    if (!body) return sendText(res, 400, 'Invalid JSON body');
    const agent = findAgent(dataDir, body.persona);
    if (!agent) return sendText(res, 400, 'Unknown agent');
    const messages = (Array.isArray(body.messages) ? body.messages : []).filter(
      (m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim(),
    );
    if (messages.at(-1)?.role !== 'user') return sendText(res, 400, 'The last message must be from the user');

    const question = messages.at(-1).content;
    const memory = await getMemory(LOCAL_USER.id);
    await addMessage(LOCAL_USER.id, agent.id, 'user', question);
    const { llm, embedder } = runtimeFor(agent);

    const controller = new AbortController();
    res.on('close', () => controller.abort());
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });

    let reply = '';
    try {
      const events = respond({
        agent,
        messages,
        sessionId: docsKey,
        llm,
        embedder,
        userNote: memoryNote(LOCAL_USER, memory, agent),
        study: agent.ncert ? memory.study : null,
        signal: controller.signal,
      });
      for await (const event of events) {
        if (controller.signal.aborted) break;
        if (event.type === 'text') reply += event.text;
        if (event.type === 'study') await saveStudy(LOCAL_USER.id, event);
        res.write(JSON.stringify(event) + '\n');
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        console.error('[chat]', err.message);
        res.write(JSON.stringify({ type: 'error', text: err.message }) + '\n');
      }
    }
    const interrupted = controller.signal.aborted;
    res.end();
    if (reply.trim()) {
      await addMessage(LOCAL_USER.id, agent.id, 'assistant', interrupted ? `${reply}…` : reply);
      if (!interrupted) learnFromTurn(LOCAL_USER.id, question, utilityLlm);
    }
  }

  async function handleDocs(req, res, url) {
    if (req.method === 'GET') return sendJson(res, 200, { docs: listDocuments(utilityEmbedder, docsKey) });
    if (req.method === 'DELETE') {
      return sendJson(res, 200, { removed: removeDocument(utilityEmbedder, docsKey, url.searchParams.get('id')) });
    }
    if (req.method === 'POST') {
      const body = await readJson(req, 8_000_000);
      if (!body) return sendText(res, 400, 'Invalid request');
      try {
        let doc;
        if (body.url) {
          const page = await fetchPage(body.url);
          doc = await addDocument(utilityEmbedder, docsKey, { title: page.title, text: page.text, source: page.url, type: 'link' });
        } else if (typeof body.text === 'string' && body.text.trim()) {
          doc = await addDocument(utilityEmbedder, docsKey, {
            title: String(body.title || 'Document').slice(0, 200),
            text: body.text.slice(0, MAX_DOC_CHARS),
            type: body.type === 'pdf' ? 'pdf' : 'text',
          });
        } else return sendText(res, 400, 'Send either a url or some text');
        return sendJson(res, 200, { doc });
      } catch (err) {
        return sendJson(res, 422, { error: err.message });
      }
    }
    sendText(res, 405, 'Method not allowed');
  }

  async function handleMemory(req, res, url) {
    if (req.method === 'GET') {
      return sendJson(res, 200, {
        user: LOCAL_USER,
        memory: await getMemory(LOCAL_USER.id),
        history: await historyCounts(LOCAL_USER.id),
      });
    }
    if (req.method === 'DELETE') {
      const fact = url.searchParams.get('fact');
      const field = url.searchParams.get('field');
      if (fact || field) await forget(LOCAL_USER.id, { fact, field });
      else await eraseAll(LOCAL_USER.id);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST') {
      const body = (await readJson(req, 10_000)) || {};
      LOCAL_USER.name = String(body.name || LOCAL_USER.name).trim().slice(0, 40) || 'You';
      return sendJson(res, 200, { user: LOCAL_USER });
    }
    sendText(res, 405, 'Method not allowed');
  }

  /** Settings-window API. Unlike /api/personas this includes the prompt. */
  async function handleDesktopAgents(req, res, url) {
    if (req.method === 'GET') return sendJson(res, 200, { agents: allAgents(dataDir) });
    if (req.method === 'POST') {
      const body = await readJson(req, 200_000);
      if (!body) return sendText(res, 400, 'Invalid request');
      try {
        return sendJson(res, 200, { agent: saveUserAgent(dataDir, body) });
      } catch (err) {
        return sendJson(res, 422, { error: err.message });
      }
    }
    if (req.method === 'DELETE') {
      return sendJson(res, 200, { removed: deleteUserAgent(dataDir, url.searchParams.get('id')) });
    }
    sendText(res, 405, 'Method not allowed');
  }

  async function handleHealth(res) {
    let ok = true;
    let error = null;
    let warning = null;
    try {
      const names = await utilityLlm.listModels();
      const has = (m) => names.includes(m) || names.includes(`${m}:latest`);
      if (!has(utilityLlm.model)) {
        ok = false;
        error = `Model "${utilityLlm.model}" isn't downloaded yet. Run: ollama pull ${utilityLlm.model}`;
      } else if (!has(utilityEmbedder.model)) {
        warning = `Document search is off until you run: ollama pull ${utilityEmbedder.model}`;
      }
    } catch {
      ok = false;
      error = `Can't reach Ollama at ${utilityLlm.baseUrl}. Start it with: ollama serve`;
    }
    // Voice runs in the browser for now; the local speech service lands later.
    sendJson(res, 200, { ok, tts: { ok: false }, ncert: { ok: false }, error, warning });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    try {
      if (pathname.startsWith('/api/')) {
        // No accounts on the desktop: report a signed-in local user so the
        // browser UI skips its sign-in gate entirely.
        if (pathname === '/api/auth/me') return sendJson(res, 200, { user: LOCAL_USER, signupMode: 'closed' });
        if (pathname === '/api/auth/logout') return sendJson(res, 200, { ok: true });
        if (pathname.startsWith('/api/auth/')) return sendJson(res, 200, { user: LOCAL_USER });

        if (pathname === '/api/personas' && req.method === 'GET') {
          return sendJson(res, 200, { personas: allAgents(dataDir).map(publicView) });
        }
        if (pathname === '/api/health' && req.method === 'GET') return await handleHealth(res);
        if (pathname === '/api/books' && req.method === 'GET') return sendJson(res, 200, { ok: false, catalog: {} });
        if (pathname === '/api/chat' && req.method === 'POST') return await handleChat(req, res);
        if (pathname === '/api/call' && req.method === 'GET') {
          const agent = findAgent(dataDir, url.searchParams.get('persona'));
          if (!agent) return sendText(res, 400, 'Unknown agent');
          const history = await getHistory(LOCAL_USER.id, agent.id);
          return sendJson(res, 200, { history, greeting: greetingFor(agent, LOCAL_USER, await getMemory(LOCAL_USER.id), history.length > 0) });
        }
        if (pathname === '/api/docs') return await handleDocs(req, res, url);
        if (pathname === '/api/memory') return await handleMemory(req, res, url);
        if (pathname === '/api/tts' || pathname === '/api/stt') {
          return sendJson(res, 502, { error: 'The local speech service is not part of this build yet.' });
        }

        // Desktop-only, for the settings window.
        if (pathname === '/api/desktop/agents') return await handleDesktopAgents(req, res, url);
        if (pathname === '/api/desktop/models' && req.method === 'GET') {
          try {
            return sendJson(res, 200, { models: await utilityLlm.listModels() });
          } catch (err) {
            return sendJson(res, 200, { models: [], error: err.message });
          }
        }
        if (pathname === '/api/desktop/status' && req.method === 'GET') {
          return sendJson(res, 200, {
            dataDir,
            port: server.address()?.port,
            provider: utilityLlm.kind,
            model: utilityLlm.model,
            baseUrl: utilityLlm.baseUrl,
            agents: allAgents(dataDir).length,
          });
        }
        return sendText(res, 404, `not found: ${pathname}`);
      }
      // The settings window lives here rather than in ../public so it is
      // served same-origin with the API (no CORS) but never reaches the cloud.
      if (pathname === '/settings' || pathname === '/settings.html') {
        const html = await readFile(join(fileURLToPath(new URL('.', import.meta.url)), 'settings.html'));
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        return res.end(html);
      }
      await serveStatic(req, res, decodeURIComponent(pathname));
    } catch (err) {
      console.error('[host]', err);
      if (!res.headersSent) sendText(res, 500, 'Something went wrong');
      else res.end();
    }
  });

  return new Promise((done) => {
    server.listen(port, host, () => done({ server, port: server.address().port, url: `http://${host}:${server.address().port}` }));
  });
}

// `npm run host` inside desktop/ runs the server without Electron, which is how
// the host is tested in CI and from a terminal.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const dataDir = process.env.HELLO_CREW_DATA || join(process.cwd(), '.hello-crew-data');
  const { url } = await startHost({ dataDir, port: Number(process.env.PORT) || 3100 });
  console.log(`Hello Crew desktop host running at ${url}`);
  console.log(`Data directory: ${dataDir}`);
}
