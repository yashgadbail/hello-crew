// Ollama adapter for the provider interface (see ./index.js).
//
// Two factories, because chat and embedding use different models and only the
// chat side needs streaming and tools:
//   chatProvider({ model, baseUrl })  -> { json, stream, ... }
//   embedder({ model, baseUrl })      -> { embed, ... }
//
// Error policy, which callers depend on:
//   json()   never throws. It returns null on any failure (network, HTTP, bad
//            JSON) so a steering step can degrade instead of killing the turn.
//   stream() throws. It produces the user's actual reply, so a missing model
//            must surface rather than be silently swallowed.
const DEFAULT_URL = 'http://127.0.0.1:11434';

const trim = (url) => (url || DEFAULT_URL).replace(/\/$/, '');

/** Body fields every Ollama call shares. Keeping the model warm avoids a cold
 *  start mid-call; "thinking" is off because silent reasoning is dead air on a
 *  voice call. Both are Ollama-specific: other providers translate or drop them. */
function baseBody(model, keepAlive) {
  return { model, keep_alive: keepAlive, think: false };
}

async function postChat({ baseUrl, model, keepAlive }, body, signal) {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...baseBody(model, keepAlive), ...body }),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const hint = res.status === 404 ? ` Try: ollama pull ${model}` : '';
    throw new Error(`Ollama error ${res.status}: ${detail}${hint}`);
  }
  return res;
}

export function chatProvider({ model, baseUrl, keepAlive = '30m' } = {}) {
  const cfg = { baseUrl: trim(baseUrl), model, keepAlive };

  return {
    kind: 'ollama',
    model,
    baseUrl: cfg.baseUrl,
    // cheapRouter: a second small call costs nothing on a warm local model, so
    // the structured router in chat.js is worth it here. A billed cloud model
    // should skip it and let the model decide for itself.
    capabilities: { jsonSchema: true, tools: true, cheapRouter: true },

    /** One constrained, non-streaming call. Returns a parsed object, or null. */
    async json(messages, schema, { temperature = 0, signal } = {}) {
      try {
        const res = await postChat(cfg, { stream: false, format: schema, options: { temperature }, messages }, signal);
        return JSON.parse((await res.json()).message.content);
      } catch {
        return null;
      }
    },

    /**
     * Stream a reply. Yields { type: 'text', text } and, when tools are offered,
     * { type: 'tool_calls', calls }. Throws on transport or model errors.
     */
    async *stream(messages, { temperature = 0.7, tools, signal } = {}) {
      const body = { stream: true, options: { temperature }, messages };
      if (tools?.length) body.tools = tools;
      const res = await postChat(cfg, body, signal);

      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const data = JSON.parse(line);
          if (data.error) throw new Error(data.error);
          if (data.message?.content) yield { type: 'text', text: data.message.content };
          if (data.message?.tool_calls?.length) yield { type: 'tool_calls', calls: data.message.tool_calls };
        }
      }
    },

    /** Which models this host has pulled. Used by the per-agent health check. */
    async listModels({ signal } = {}) {
      const res = await fetch(`${cfg.baseUrl}/api/tags`, { signal });
      if (!res.ok) throw new Error(`Ollama error ${res.status}`);
      const { models = [] } = await res.json();
      return models.map((m) => m.name);
    },
  };
}

function normalize(vec) {
  let n = 0;
  for (const v of vec) n += v * v;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(vec, (v) => v / n);
}

export function embedder({ model, baseUrl, keepAlive = '30m' } = {}) {
  const url = trim(baseUrl);

  return {
    kind: 'ollama',
    model,
    /** Vectors are only comparable within one model, so the store keys on this. */
    get id() {
      return `ollama:${model}`;
    },

    /** kind: 'document' | 'query' (nomic wants a task prefix). */
    async embed(texts, kind = 'document') {
      const prefix = model.includes('nomic') ? (kind === 'query' ? 'search_query: ' : 'search_document: ') : '';
      const out = [];
      for (let i = 0; i < texts.length; i += 32) {
        const res = await fetch(`${url}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, keep_alive: keepAlive, input: texts.slice(i, i + 32).map((t) => prefix + t) }),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new Error(`Embedding failed (${res.status}). ${detail.includes('not found') ? `Run: ollama pull ${model}` : detail}`);
        }
        const { embeddings } = await res.json();
        out.push(...embeddings.map(normalize));
      }
      return out;
    },
  };
}
