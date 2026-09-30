// Resolves an agent's model config into a provider instance.
//
// A model config is { provider, name, baseUrl? }, e.g.
//   { provider: 'ollama', name: 'qwen3.5:4b' }
// Adding Claude or OpenAI later means writing an adapter with the same shape as
// ./ollama.js and adding one line to each registry below. Nothing else changes.
import * as ollama from './ollama.js';

const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');

/** Used by any agent that does not name its own model. */
export const DEFAULT_MODEL = Object.freeze({
  provider: 'ollama',
  name: process.env.OLLAMA_MODEL || 'qwen3.5:4b',
  baseUrl: OLLAMA_URL,
});

export const DEFAULT_EMBED = Object.freeze({
  provider: 'ollama',
  name: process.env.EMBED_MODEL || 'nomic-embed-text',
  baseUrl: OLLAMA_URL,
});

const CHAT = { ollama: ollama.chatProvider };
const EMBED = { ollama: ollama.embedder };

function build(registry, config, fallback, what) {
  const { provider, name, baseUrl } = { ...fallback, ...(config || {}) };
  const make = registry[provider];
  if (!make) throw new Error(`Unknown ${what} provider "${provider}". Available: ${Object.keys(registry).join(', ')}`);
  return make({ model: name, baseUrl });
}

/** Chat provider for a model config (falls back to DEFAULT_MODEL). */
export function llmFor(config) {
  return build(CHAT, config, DEFAULT_MODEL, 'model');
}

/** Embedding provider for a model config (falls back to DEFAULT_EMBED). */
export function embedderFor(config) {
  return build(EMBED, config, DEFAULT_EMBED, 'embedding');
}
