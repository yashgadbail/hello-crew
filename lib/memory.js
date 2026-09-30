// Per-user memory: chat history with each character, plus one profile the whole
// crew shares: preferred language and style, key facts, and Kiki's study progress.
// After each reply, a small structured LLM call updates the profile in the background.
const HISTORY_LIMIT = 30; // messages sent to the browser when a call starts
const MAX_FACTS = 30;
const MAX_MESSAGE_CHARS = 8000;
const EMPTY = () => ({ language: '', style: '', facts: [], study: null });

// Where memory lives. One process has exactly one database, so this is process
// state rather than a per-call argument: the cloud server sets PostgreSQL, the
// desktop host sets SQLite. There is no default on purpose, so the desktop
// never pulls in the `pg` driver just by importing this module.
let store = null;

/** Called once at boot. See lib/store/postgres.js and lib/store/sqlite.js. */
export function useStore(impl) {
  store = impl;
}

function db() {
  if (!store) throw new Error('No memory store configured. Call useStore() at startup.');
  return store;
}

// ---------------------------------------------------------------------------
// Chat history
// ---------------------------------------------------------------------------
export async function getHistory(userId, persona, limit = HISTORY_LIMIT) {
  return db().getHistory(userId, persona, limit);
}

export async function addMessage(userId, persona, role, content) {
  await db().addMessage(userId, persona, role, content.slice(0, MAX_MESSAGE_CHARS));
}

export async function historyCounts(userId) {
  return db().historyCounts(userId);
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------
export async function getMemory(userId) {
  return { ...EMPTY(), ...((await db().getMemoryData(userId)) || {}) };
}

async function saveMemory(userId, memory) {
  await db().saveMemoryData(userId, memory);
}

/** Forget one thing: a fact (by text), or a whole field ('language' | 'style' | 'study' | 'history'). */
export async function forget(userId, { fact, field }) {
  const memory = await getMemory(userId);
  if (fact) memory.facts = memory.facts.filter((f) => f !== fact);
  if (field === 'language' || field === 'style') memory[field] = '';
  if (field === 'study') memory.study = null;
  if (field === 'history') await db().deleteMessages(userId);
  await saveMemory(userId, memory);
}

export async function eraseAll(userId) {
  await db().deleteMessages(userId);
  await db().deleteMemory(userId);
}

/** Kiki confirmed a book/chapter: remember it so the next call can pick up there. */
export async function saveStudy(userId, study) {
  const memory = await getMemory(userId);
  const prev = memory.study || {};
  const recent = (prev.recent || []).filter((r) => !(r.subject === study.subject && r.chapter === study.chapter));
  if (study.chapter) recent.unshift({ subject: study.subject, chapter: study.chapter, chapter_title: study.chapter_title });
  memory.study = {
    class_num: study.class_num,
    subject: study.subject,
    // Keep the last chapter if this turn only named the book.
    chapter: study.chapter || (prev.subject === study.subject ? prev.chapter : null),
    chapter_title: study.chapter_title || (prev.subject === study.subject ? prev.chapter_title : null),
    recent: recent.slice(0, 8),
    at: Date.now(),
  };
  await saveMemory(userId, memory);
}

// ---------------------------------------------------------------------------
// Learning from a conversation turn
// ---------------------------------------------------------------------------
const LEARN_SCHEMA = {
  type: 'object',
  properties: {
    language: { type: 'string' },
    style: { type: 'string' },
    add_facts: { type: 'array', items: { type: 'string' } },
    remove_facts: { type: 'array', items: { type: 'string' } },
  },
  required: ['language', 'style', 'add_facts', 'remove_facts'],
};

const LEARN_PROMPT = `You maintain a short memory profile about a user of a voice assistant app, so every assistant can personalise future chats.
Given the current profile and the user's latest message, return updates. Use ONLY what the user's message itself says; never infer or embellish.
- language: set this only if the message is written in a language or mix other than plain English (e.g. "Hinglish (Hindi words written in English)", "Marathi and English mix"), or the user explicitly asks for a language. Plain English, or no clear evidence: return "".
- style: explicit preferences about replies, e.g. "short answers", "explain simply with examples", "likes jokes". Return "" to keep the current value.
- add_facts: NEW durable personal details the USER stated about themselves: where they live, school class, job, diet, health notes they shared, goals, family, likes, dislikes, upcoming plans or exams. Short third-person phrases that keep the user's exact meaning and key words ("vegan" stays "Vegan", never "Vegetarian"), like "Lives in Pune", "Vegan", "Board exams in March". Never include guesses, the subject or topic they're asking about or studying right now (that's tracked separately), or anything already in the profile. Usually this is empty.
- remove_facts: existing facts (copied exactly) that the user just said are wrong or out of date.`;

const learning = new Map(); // userId -> promise chain, so updates never race

/**
 * Update the profile from one exchange, in the background (never throws).
 * `llm` is the server's own utility provider, not the agent's: this outlives the
 * request, and when the agent runs on someone else's machine that provider may
 * already be gone.
 */
export function learnFromTurn(userId, userText, llm) {
  if (userText.trim().split(/\s+/).length < 3) return; // "yes", "ok thanks"…
  const prev = learning.get(userId) || Promise.resolve();
  const next = prev.then(() => learn(userId, userText, llm)).catch((err) => console.warn('[memory]', err.message));
  learning.set(userId, next);
  next.finally(() => learning.get(userId) === next && learning.delete(userId));
}

async function learn(userId, userText, llm) {
  const memory = await getMemory(userId);
  const profile = { language: memory.language, style: memory.style, facts: memory.facts };
  const out = await llm.json(
    [
      { role: 'system', content: LEARN_PROMPT },
      // Only the user's own words: the assistant's reply led to invented "facts".
      { role: 'user', content: `Current profile: ${JSON.stringify(profile)}\n\nUser's latest message: ${userText.slice(0, 1500)}` },
    ],
    LEARN_SCHEMA,
  );
  if (!out) return; // model unavailable or gave unparseable output: keep the profile as is
  const fresh = await getMemory(userId); // may have changed while the model ran
  let changed = false;
  for (const key of ['language', 'style']) {
    const v = String(out[key] || '').trim().slice(0, 120);
    if (v && v.toLowerCase() !== fresh[key].toLowerCase()) (fresh[key] = v), (changed = true);
  }
  const remove = new Set((out.remove_facts || []).map((f) => String(f).toLowerCase()));
  if (remove.size) {
    const before = fresh.facts.length;
    fresh.facts = fresh.facts.filter((f) => !remove.has(f.toLowerCase()));
    changed ||= fresh.facts.length !== before;
  }
  const known = new Set(fresh.facts.map((f) => f.toLowerCase()));
  for (const f of out.add_facts || []) {
    const fact = String(f).trim().replace(/\.$/, '').slice(0, 140);
    if (fact.length > 2 && !known.has(fact.toLowerCase())) {
      fresh.facts.push(fact);
      known.add(fact.toLowerCase());
      changed = true;
    }
  }
  fresh.facts = fresh.facts.slice(-MAX_FACTS);
  if (changed) await saveMemory(userId, fresh);
}

// ---------------------------------------------------------------------------
// Using memory in a conversation
// ---------------------------------------------------------------------------
/** Private notes for the system prompt: who the user is and what the crew remembers. */
export function memoryNote(user, memory, persona) {
  const lines = [
    `You're talking with ${user.name}. Use their name naturally now and then (a greeting, encouragement), not in every sentence. Don't assume their gender: no "bhai", "didi", "bro", "sir" or "ma'am".`,
  ];
  if (memory.language) lines.push(`They like to talk in ${memory.language}. Reply in that same way, but keep it easy to read aloud.`);
  if (memory.style) lines.push(`Their preferences for replies: ${memory.style}.`);
  if (memory.facts.length) {
    lines.push(
      `What you remember about ${user.name} from earlier chats. Use a detail only when it clearly fits the current question (e.g. their diet for a recipe, their city for a trip); otherwise ignore it, and never list these back:\n- ${memory.facts.join('\n- ')}`,
    );
  }
  if (persona.ncert && memory.study) {
    const s = memory.study;
    lines.push(`Last time with you they studied Class ${s.class_num} ${s.subject}${s.chapter ? `, Chapter ${s.chapter}: ${s.chapter_title}` : ''}.`);
  }
  return lines.join('\n');
}

const titleCase = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** The first thing a character says when the call connects. */
export function greetingFor(persona, user, memory, hasHistory) {
  const name = user.name.split(' ')[0];
  if (persona.ncert && memory.study) {
    const s = memory.study;
    const where = `Class ${s.class_num} ${titleCase(s.subject)}${s.chapter ? `, Chapter ${s.chapter}: ${s.chapter_title}` : ''}`;
    return `Hi ${name}, welcome back! Last time we were on ${where}. Shall we carry on with that, or study something new?`;
  }
  if (hasHistory) {
    // Drop their usual opener ("Hey there, Bruno here!") for a welcome back.
    return `Hey ${name}, good to hear from you again! ${persona.greeting.replace(/^[^!.?]*[!.?]\s*/, '')}`;
  }
  // "Hi, Jasper here" -> "Hi Asha, Jasper here"; "Hello from the moon base!" -> "Hi Asha, greetings from…";
  // otherwise just say hi first.
  const g = persona.greeting;
  if (/^Hello from\b/.test(g)) return `Hi ${name}, greetings${g.slice('Hello'.length)}`;
  const opener = g.match(/^(Hey there|Hi|Hey|Hello),?\s+/);
  return opener ? `${opener[1]} ${name}, ${g.slice(opener[0].length)}` : `Hi ${name}! ${g}`;
}
