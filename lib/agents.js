// An "agent" is a persona plus the runtime config needed to actually answer:
// which model to think with, which model to embed with, and how to look.
//
// The eight built-in characters stay hardcoded in personas.js. This module is
// the single place that fills in defaults, so when agents later come from disk
// (the desktop host) or from the database (shared agents), only the lookup
// below changes and every caller keeps working.
import { PERSONAS, publicPersona } from './personas.js';
import { DEFAULT_MODEL, DEFAULT_EMBED, llmFor, embedderFor } from './providers/index.js';

/** Procedural avatars: a seeded shape with eyes, so a new agent needs no assets. */
const SHAPES = ['capsule', 'sphere', 'box', 'cone', 'torus'];

function seedFrom(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Kenney model if the agent names one, otherwise a shape derived from its id. */
function resolveAvatar(persona) {
  if (persona.avatar) return persona.avatar;
  if (persona.character) return { kind: 'kenney', character: persona.character, scene: persona.scene };
  const seed = seedFrom(persona.id);
  return {
    kind: 'shape',
    shape: SHAPES[seed % SHAPES.length],
    color: persona.color || `hsl(${seed % 360} 70% 60%)`,
    seed,
  };
}

/** Fill in everything the runtime needs. Returns a new object; never mutates. */
export function toAgent(persona) {
  return {
    ...persona,
    model: persona.model ?? DEFAULT_MODEL,
    embed: persona.embed ?? DEFAULT_EMBED,
    avatar: resolveAvatar(persona),
  };
}

export function listAgents() {
  return PERSONAS.map(toAgent);
}

/** @returns {object|null} the agent, or null if there is no such id. */
export function resolveAgent(id) {
  const persona = PERSONAS.find((p) => p.id === id);
  return persona ? toAgent(persona) : null;
}

/** The provider instances for one agent. Cheap to build, so do it per turn. */
export function runtimeFor(agent) {
  return { llm: llmFor(agent.model), embedder: embedderFor(agent.embed) };
}

/** Browser-safe view: no system prompt, and no internal model endpoints. */
export function publicAgent(agent) {
  const { model, embed, ...rest } = publicPersona(agent);
  return { ...rest, model: model ? { provider: model.provider, name: model.name } : undefined };
}
