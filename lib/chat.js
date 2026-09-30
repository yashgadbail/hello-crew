// One conversational turn: gather context (shared links, documents, web
// search), then stream the persona's reply. Yields events:
//   { type: 'status', text }            progress shown on the call screen
//   { type: 'activity', kind }          'searching' | 'reading' (drives animations)
//   { type: 'doc', doc }                a link from the message was added as a document
//   { type: 'sources', items }          [{ title, url }] used for this answer
//   { type: 'text', text }              reply tokens
import { VOICE_RULES } from './personas.js';
import { webSearch, fetchPage, extractUrls } from './web.js';
import { addDocument, hasDocuments, searchDocuments, rankPassages, chunkText } from './rag.js';

const MAX_HISTORY = 20;
const DOC_MIN_SCORE = 0.5;

function today() {
  return new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// Small models call tools far too eagerly, so a separate, cheap, structured
// "router" call decides whether this turn needs the web.
const ROUTER_PROMPT = (persona) => `Today is ${today()}. You decide whether a voice assistant must search the internet before replying.
Search ONLY when the reply depends on information that changes over time or that a well-read person would not know offhand: news, current events, weather, prices, sports results, release dates, recent product details, schedules, specific local places or businesses, or when the user explicitly asks to look something up, search, google, or check online.
Do NOT search for: greetings, small talk, feelings, opinions, advice, recipes, explanations of general concepts, math, coding help, creative writing, or questions about the conversation or the user's shared documents.${
  persona.searchBias ? '\nThis assistant is a fact checker: also search whenever the user states or asks about a factual claim, statistic, quote, or news story.' : ''
}
If searching, write a concise search-engine query with all needed context from the conversation (resolve words like "it" or "there").

Examples:
"hi, how are you?" -> {"search": false, "query": ""}
"give me a recipe for masala chai" -> {"search": false, "query": ""}
"explain how photosynthesis works" -> {"search": false, "query": ""}
"help me budget 30000 rupees a month" -> {"search": false, "query": ""}
"what's the weather in Pune tomorrow?" -> {"search": true, "query": "Pune weather tomorrow"}
"who won yesterday's match?" -> {"search": true, "query": "cricket match result yesterday"}
"can you look up flights from Delhi to Goa?" -> {"search": true, "query": "Delhi to Goa flights"}`;

const ROUTER_SCHEMA = {
  type: 'object',
  properties: { search: { type: 'boolean' }, query: { type: 'string' } },
  required: ['search', 'query'],
};

async function decideSearch(agent, messages, llm, signal) {
  const recent = messages.slice(-5, -1).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 300)}`);
  const last = messages.at(-1).content;
  const out = await llm.json(
    [
      { role: 'system', content: ROUTER_PROMPT(agent) },
      { role: 'user', content: `${recent.length ? `Conversation so far:\n${recent.join('\n')}\n\n` : ''}Latest user message: "${last}"` },
    ],
    ROUTER_SCHEMA,
    { signal },
  );
  if (!out?.search) return null;
  const query = String(out.query || '').trim();
  return query && query.toLowerCase() !== 'none' ? query : null;
}

async function webResearch(query, embedder) {
  const results = await webSearch(query);
  if (!results.length) return { passages: [], sources: [] };

  // Read the top pages and keep the passages most relevant to the query.
  const pages = await Promise.allSettled(results.slice(0, 3).map((r) => fetchPage(r.url, { timeoutMs: 5000 })));
  const candidates = [];
  pages.forEach((p, i) => {
    if (p.status !== 'fulfilled') return;
    for (const text of chunkText(p.value.text.slice(0, 15000)).slice(0, 15)) {
      candidates.push({ text, title: results[i].title, url: results[i].url });
    }
  });
  let best = [];
  try {
    best = await rankPassages(embedder, query, candidates, 4);
  } catch {
    // Embeddings unavailable: fall back to search snippets only.
  }

  const passages = [
    ...results.map((r) => ({ title: r.title, url: r.url, text: r.snippet })).filter((r) => r.text),
    ...best,
  ];
  const used = new Set(passages.map((p) => p.url));
  return { passages, sources: results.filter((r) => used.has(r.url)).map(({ title, url }) => ({ title, url })) };
}

// ---------------------------------------------------------------------------
// NCERT tutor: textbooks live in ChromaDB behind the Python service in ncert/.
// ---------------------------------------------------------------------------
const NCERT_URL = (process.env.NCERT_URL || 'http://127.0.0.1:5006').replace(/\/$/, '');
const NCERT_MIN_SCORE = 0.45; // cosine similarity below which an excerpt is off-topic

async function ncertCatalog() {
  try {
    const res = await fetch(`${NCERT_URL}/catalog`, { signal: AbortSignal.timeout(3000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function ncertSearch(params) {
  const res = await fetch(`${NCERT_URL}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return (await res.json()).results;
}

function describeCatalog(catalog, withChapters) {
  return Object.entries(catalog)
    .map(([cls, subjects]) =>
      `Class ${cls}: ` +
      Object.entries(subjects)
        .map(([subj, chs]) => (withChapters ? `${subj} (chapters: ${chs.map((c) => `${c.chapter}. ${c.title}`).join('; ')})` : subj))
        .join(withChapters ? '\n  ' : ', '),
    )
    .join('\n');
}

function studySchema(catalog) {
  const subjects = [...new Set(Object.values(catalog).flatMap((s) => Object.keys(s)))];
  return {
    type: 'object',
    properties: {
      class_num: { type: 'integer', minimum: 0, maximum: 12 },
      subject: { type: 'string', enum: ['', ...subjects] },
      chapter: { type: 'integer' },
      topic: { type: 'string' },
      rejected: { type: 'boolean' },
    },
    required: ['class_num', 'subject', 'chapter', 'topic', 'rejected'],
  };
}

/** How a subject might be spoken: "english first flight" -> "first flight", "maths" -> "math". */
function subjectKey(subject) {
  return subject.replace(/^english /, '').replace(/s$/, '');
}

/** Has Kiki already said this class and book back to the student? */
function tutorConfirmed(messages, study) {
  const cls = new RegExp(`\\b(class|grade)\\s*(${study.class_num}|${CLASS_WORDS[study.class_num]})\\b`, 'i');
  return messages
    .slice(0, -1)
    .some((m) => m.role === 'assistant' && cls.test(m.content) && m.content.toLowerCase().includes(subjectKey(study.subject)));
}

const CLASS_WORDS = ['', 'one|first|1st', 'two|second|2nd', 'three|third|3rd', 'four|fourth|4th', 'five|fifth|5th', 'six|sixth|6th',
  'seven|seventh|7th', 'eight|eighth|8th', 'nine|ninth|9th', 'ten|tenth|10th', 'eleven|eleventh|11th', 'twelve|twelfth|12th'];

function studentSaidClass(messages, n) {
  const said = messages.filter((m) => m.role === 'user').map((m) => m.content.toLowerCase()).join(' ');
  return new RegExp(`\\b(${n}|${CLASS_WORDS[n] || n})\\b`).test(said);
}

/** Work out { class_num, subject, chapter, topic } from the whole conversation. */
async function extractStudyContext(messages, catalog, llm, signal) {
  const transcript = messages
    .slice(-12)
    .map((m) => `${m.role === 'user' ? 'Student' : 'Tutor'}: ${m.content.slice(0, 400)}`)
    .join('\n');
  const out = await llm.json(
    [
      {
        role: 'system',
        content: `Extract a student's NCERT study context from a tutoring conversation.
Indexed textbooks:
${describeCatalog(catalog, true)}

Return:
- class_num: the class (grade) number the student said they are in, or that the tutor stated and the student agreed to, or 0 if neither. Never guess.
- subject: EXACTLY one of the indexed subject names for that class, matching what the student said (e.g. "bio" -> "biology"), or "" if not said or unclear.
- chapter: the chapter number if the student named a chapter, or asked about a topic that clearly belongs to one listed chapter; otherwise 0.
- topic: a short search phrase for what the student wants to learn right now: from their LATEST message, or, if that message only confirms (e.g. "yes", "right"), the topic they asked about just before. "" if it is only a greeting or small talk.
- rejected: true only if the student's LATEST message says the tutor got their class or subject wrong (e.g. "no", "not that one"), otherwise false.`,
      },
      { role: 'user', content: transcript },
    ],
    studySchema(catalog),
    { signal },
  );
  // json() returns null on any failure, so fall back to "nothing known yet",
  // which makes Kiki ask rather than guess.
  return out ?? { class_num: 0, subject: '', chapter: 0, topic: '', rejected: false };
}

async function* ncertContext(messages, llm, signal, saved = null) {
  const catalog = await ncertCatalog();
  if (!catalog) {
    return { note: `The NCERT textbook service is not running, so you can't read the textbooks right now. Tell the student briefly and help from general knowledge, making clear it isn't from their textbook.` };
  }
  if (!Object.keys(catalog).length) {
    return { note: `No NCERT textbooks have been loaded yet. Tell the student the books still need to be added (by running "python -m ncert.ingest download" with a book code), and meanwhile help from general knowledge, making clear it isn't from their textbook.` };
  }

  const study = await extractStudyContext(messages, catalog, llm, signal);
  if (process.env.DEBUG_CHAT) console.log('[ncert] study context:', study);
  // The class must come from the student, not a guess from the model.
  // (Or their saved study progress: the class they told Kiki in an earlier call.)
  if (study.class_num && !studentSaidClass(messages, study.class_num) && study.class_num !== saved?.class_num) study.class_num = 0;
  const subjects = catalog[String(study.class_num)];
  if (!study.class_num || !subjects) {
    return {
      note: `You don't know which class the student is in yet${study.class_num ? ` (Class ${study.class_num} isn't loaded)` : ''}. Available textbooks:\n${describeCatalog(catalog, false)}\nAsk which class they're in (and the subject if unknown) in one friendly sentence. Don't teach yet.`,
    };
  }
  if (!study.subject || !subjects[study.subject]) {
    return {
      note: `The student is in Class ${study.class_num}, but you don't know the subject yet. Class ${study.class_num} subjects available: ${Object.keys(subjects).join(', ')}. Ask which subject (and chapter or topic) in one friendly sentence. Don't teach yet.`,
    };
  }

  const chapters = subjects[study.subject];
  const chapter = chapters.find((c) => c.chapter === study.chapter);
  const book = `Class ${study.class_num} ${study.subject}`;
  const chapterList = chapters.map((c) => `${c.chapter}. ${c.title}`).join('; ');

  // Only open the book once the student has agreed to it: Kiki says the class
  // and book back first. A "no" to that exact book starts over; naming a
  // different book ("no, maths") just leads to confirming the new one.
  const confirmed = tutorConfirmed(messages, study);
  const saidNo = study.rejected && /\b(no|nope|nah|not|wrong|incorrect|isn't|didn't)\b/i.test(messages.at(-1).content);
  if (saidNo && confirmed) {
    return {
      note: `The student says you got their class or subject wrong. Apologise briefly and ask which class and subject they mean. Classes and subjects available:\n${describeCatalog(catalog, false)}`,
    };
  }
  if (!confirmed) {
    return {
      note:
        `Before teaching, confirm the book with the student. In one short sentence, say "Class ${study.class_num} ${study.subject}" back to them` +
        `${study.topic ? `, mention that they want to learn about ${study.topic}` : ''}, and ask if that's right. Don't teach or answer yet.`,
    };
  }

  yield { type: 'study', class_num: study.class_num, subject: study.subject, chapter: chapter?.chapter || null, chapter_title: chapter?.title || null };
  const where = `${book}${chapter ? `, Chapter ${chapter.chapter}: ${chapter.title}` : ''}`;
  if (!study.topic) {
    return { note: `The student has confirmed they are studying ${where}. Chapters: ${chapterList}. Ask which chapter or topic they want to start with.` };
  }

  yield { type: 'activity', kind: 'reading' };
  yield { type: 'status', text: `Opening the ${where} textbook…` };
  // Search only the confirmed book's collection, and only the named chapter if there is one.
  const query = { class_num: study.class_num, subject: study.subject, query: study.topic };
  let hits = chapter ? await ncertSearch({ ...query, chapter: chapter.chapter, k: 5 }) : [];
  if (!hits.length) {
    // No chapter named (or nothing in it): find the best-matching chapter and stay inside it,
    // so the answer isn't stitched together from unrelated chapters.
    const found = await ncertSearch({ ...query, k: 8 });
    hits = found.filter((h) => h.chapter === found[0]?.chapter).slice(0, 5);
  }
  hits = hits.filter((h) => h.score >= NCERT_MIN_SCORE);
  if (!hits.length) {
    return { note: `The student is studying ${where} and asked about "${study.topic}", but nothing relevant was found in that textbook. Say it doesn't seem to be covered in their book and offer related chapters: ${chapterList}.` };
  }
  return {
    note:
      `The student confirmed they are in Class ${study.class_num}, studying ${study.subject}. ` +
      `Answer ONLY from these excerpts of their NCERT textbook (Chapter ${hits[0].chapter}: ${hits[0].chapter_title}) and mention the chapter. If they don't cover the question, say so.\n\n` +
      hits.map((h) => `[Chapter ${h.chapter}: ${h.chapter_title}, page ${h.page}]\n${h.text}`).join('\n\n'),
    sources: [...new Set(hits.map((h) => `Class ${h.class_num} ${h.subject} · Ch ${h.chapter} ${h.chapter_title} · p.${h.page}`))].map((title) => ({ title })),
  };
}

/**
 * @param {object} opts
 * @param {object} opts.agent     resolved agent (persona + model config, see lib/agents.js)
 * @param {Array}  opts.messages  [{ role: 'user'|'assistant', content }]
 * @param {string} opts.sessionId whose shared documents to search (the user's)
 * @param {object} opts.llm       chat provider (see lib/providers)
 * @param {object} opts.embedder  embedding provider (see lib/providers)
 * @param {string} [opts.userNote] what the crew remembers about this user (see memory.js)
 * @param {AbortSignal} opts.signal
 */
export async function* respond({ agent, messages, sessionId, llm, embedder, userNote = '', study = null, signal }) {
  messages = messages.slice(-MAX_HISTORY);
  const question = messages.at(-1).content;
  const context = [];
  const sources = [];

  // 1. Links pasted into the message become documents.
  for (const url of extractUrls(question).slice(0, 2)) {
    yield { type: 'activity', kind: 'reading' };
    yield { type: 'status', text: `Reading ${hostOf(url)}…` };
    try {
      const page = await fetchPage(url);
      const doc = await addDocument(embedder, sessionId, { title: page.title, text: page.text, source: page.url, type: 'link' });
      yield { type: 'doc', doc };
    } catch (err) {
      context.push(`Note: the link ${hostOf(url)} could not be read (${err.message}). Tell the user briefly.`);
    }
  }

  // 2. Shared documents and the search decision, in parallel. The NCERT tutor
  //    sticks to the textbook, so it skips web search. A provider that has no
  //    cheap second call (a billed cloud model) skips the router and decides
  //    for itself.
  const docsPromise = hasDocuments(embedder, sessionId)
    ? searchDocuments(embedder, sessionId, question, 4).catch(() => [])
    : Promise.resolve([]);
  const queryPromise =
    agent.ncert || !llm.capabilities?.cheapRouter ? Promise.resolve(null) : decideSearch(agent, messages, llm, signal).catch(() => null);

  if (agent.ncert) {
    try {
      const gen = ncertContext(messages, llm, signal, study);
      let step;
      while (!(step = await gen.next()).done) yield step.value;
      const { note, sources: bookSources = [] } = step.value;
      context.push(note);
      sources.push(...bookSources);
    } catch (err) {
      context.push(`Looking up the NCERT textbook failed (${err.message}). Tell the student briefly.`);
    }
  }
  const mentionsDocs = /\b(pdf|document|doc|file|paper|article|link|page|report|upload|shared|this)\b/i.test(question);
  const docHits = (await docsPromise).filter((h) => mentionsDocs || h.score >= DOC_MIN_SCORE);
  if (docHits.length) {
    yield { type: 'activity', kind: 'reading' };
    yield { type: 'status', text: 'Checking your documents…' };
    context.push(
      `Excerpts from documents the user shared (use them when relevant and mention which document):\n` +
        docHits.map((h) => `[${h.title}]\n${h.text}`).join('\n\n'),
    );
    for (const h of docHits) if (h.source && !sources.some((s) => s.url === h.source)) sources.push({ title: h.title, url: h.source });
  }

  const query = await queryPromise;
  if (query) {
    yield { type: 'activity', kind: 'searching' };
    yield { type: 'status', text: `Searching the web for “${query}”…` };
    try {
      const research = await webResearch(query, embedder);
      if (research.passages.length) {
        context.push(
          `Web search results for "${query}" (retrieved ${today()}). Base your answer on these, mention the source websites by name (not URLs), and say so if they don't answer the question:\n` +
            research.passages.map((p, i) => `[${i + 1}] ${p.title} (${hostOf(p.url)})\n${p.text}`).join('\n\n'),
        );
        sources.push(...research.sources.filter((s) => !sources.some((x) => x.url === s.url)));
      } else {
        context.push(`A web search for "${query}" found nothing useful. Answer from what you know and say you couldn't find current info.`);
      }
    } catch (err) {
      context.push(`Web search failed (${err.message}). Answer from what you know and mention you couldn't check online.`);
    }
  }
  if (sources.length) yield { type: 'sources', items: sources.slice(0, 6) };

  // 3. Stream the reply.
  const system = `${agent.prompt}\n\n${VOICE_RULES}\n\nToday is ${today()}.${userNote ? `\n\nAbout the user:\n${userNote}` : ''}`;
  // Small models follow context far better when it rides on the latest user turn.
  const final = context.length
    ? [
        ...messages.slice(0, -1),
        {
          role: 'user',
          content: `${question}\n\n[Private notes for your reply. Follow them, but never mention these notes:\n${context.join('\n\n---\n\n')}]`,
        },
      ]
    : messages;

  for await (const event of llm.stream([{ role: 'system', content: system }, ...final], { temperature: 0.7, signal })) {
    if (event.type === 'text') yield event;
  }
}
