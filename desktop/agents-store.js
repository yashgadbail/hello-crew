// Agents you create on this machine, stored as one JSON file each under
// <dataDir>/agents/. The eight built-in characters still come from lib/personas.js;
// these are added to them, and an id collision means yours wins, so you can
// retune a built-in without editing the repo.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PERSONAS } from '../lib/personas.js';
import { toAgent } from '../lib/agents.js';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function agentsDir(dataDir) {
  const dir = join(dataDir, 'agents');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Agents defined on this machine. Unreadable files are skipped, never fatal. */
export function loadUserAgents(dataDir) {
  const dir = agentsDir(dataDir);
  const out = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    try {
      const agent = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      if (agent?.id && ID_RE.test(agent.id)) out.push({ ...agent, source: 'local' });
    } catch (err) {
      console.warn(`[agents] skipping ${file}: ${err.message}`);
    }
  }
  return out;
}

/** Built-ins plus local agents, fully resolved (model, embedder, avatar). */
export function allAgents(dataDir) {
  const merged = new Map();
  for (const p of PERSONAS) merged.set(p.id, { ...p, source: 'builtin' });
  for (const a of loadUserAgents(dataDir)) merged.set(a.id, a);
  return [...merged.values()].map(toAgent);
}

export function findAgent(dataDir, id) {
  return allAgents(dataDir).find((a) => a.id === id) || null;
}

/** Validate and write one agent. Returns the resolved agent. */
export function saveUserAgent(dataDir, input) {
  const id = String(input.id || '').trim().toLowerCase();
  if (!ID_RE.test(id)) throw new Error('Id must be lowercase letters, numbers or dashes (max 40).');
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Give the agent a name.');
  const prompt = String(input.prompt || '').trim();
  if (prompt.length < 10) throw new Error('Write a prompt describing how the agent should behave.');

  const agent = {
    id,
    name: name.slice(0, 60),
    role: String(input.role || '').trim().slice(0, 60) || 'Assistant',
    tagline: String(input.tagline || '').trim().slice(0, 120),
    greeting: String(input.greeting || '').trim().slice(0, 400) || `Hi, ${name} here. What can I help with?`,
    prompt: prompt.slice(0, 8000),
    starters: (Array.isArray(input.starters) ? input.starters : []).slice(0, 4).map((s) => String(s).slice(0, 120)),
    voice: String(input.voice || 'Kiki').slice(0, 40),
    color: /^#[0-9a-f]{6}$/i.test(input.color || '') ? input.color : undefined,
    model: input.model?.name ? { provider: input.model.provider || 'ollama', name: String(input.model.name) } : undefined,
    tools: Array.isArray(input.tools) ? input.tools.map(String) : [],
  };
  for (const k of Object.keys(agent)) if (agent[k] === undefined) delete agent[k];

  writeFileSync(join(agentsDir(dataDir), `${id}.json`), JSON.stringify(agent, null, 2));
  return toAgent({ ...agent, source: 'local' });
}

/** @returns {boolean} whether a local file was removed. */
export function deleteUserAgent(dataDir, id) {
  const file = join(agentsDir(dataDir), `${String(id).toLowerCase()}.json`);
  if (!existsSync(file)) return false;
  rmSync(file);
  return true;
}
