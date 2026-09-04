// Local bridge to de.aipass.net's chat.
//
// The bridge never sees a session cookie. It hands work to the Chrome
// extension over SSE; the extension performs the real request from inside a
// de.aipass.net page, where the browser attaches credentials itself.
//
// Scope is deliberately narrow: send the user's message, stream the reply
// back. The server owns the conversation and its history, exactly as it does
// for the web UI, so there is nothing to reconstruct on this side.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { E, errorBody } from '../security/errors.mjs';
import { redact } from '../security/dlp.mjs';
import {
  checkAuth, mintKey, isMintedKey, conversationForKey,
  setConversationForKey, loadToken, tokenFilePath,
} from '../security/auth.mjs';
import { originAllowed, corsHeaders, preflightHeaders, rejectOrigin } from '../security/cors.mjs';

const PORT = Number(process.env.AIPASS_PORT ?? 8787);
const HOST = process.env.AIPASS_HOST ?? '127.0.0.1';
const MODELS_FALLBACK = (process.env.AIPASS_MODELS ?? 'gemini-3.1-flash-lite,claude-sonnet-5@default')
  .split(',').map((s) => s.trim()).filter(Boolean);
// Where upstream tool activity (web_search progress, sources) goes:
// 'reasoning' -> delta.reasoning_content, 'text' -> inline, 'off' -> dropped.
const TOOL_VISIBILITY = process.env.AIPASS_TOOL_VISIBILITY ?? 'reasoning';
const PINNED_CONVERSATION = process.env.AIPASS_CONVERSATION_ID ?? '';
const IDLE_TIMEOUT_MS = Number(process.env.AIPASS_IDLE_TIMEOUT_MS ?? 180_000);
const MAX_BODY = 8 * 1024 * 1024;

let defaultModel = process.env.AIPASS_MODEL ?? 'gemini-3.1-flash-lite';
// Bind newly created conversations to a custom aipass assistant. The form field
// name is not yet confirmed from a capture, so it is configurable; the default
// is the most likely candidate and is harmless if the server ignores it.
let assistantId = process.env.AIPASS_ASSISTANT_ID ?? '';
const ASSISTANT_FIELD = process.env.AIPASS_ASSISTANT_FIELD ?? 'aiAssistantId';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ------------------------------------------------- react-router turbo-stream */

// The app's .data loaders return a flat pool of values where objects address
// their keys and values by index.
function decodeTurboStream(text) {
  const flat = JSON.parse(text);
  const seen = new Map();
  const resolve = (ref) => {
    if (typeof ref !== 'number') return ref;
    if (ref < 0) return null; // undefined / null sentinels
    if (seen.has(ref)) return seen.get(ref);
    const v = flat[ref];
    if (Array.isArray(v)) {
      const out = [];
      seen.set(ref, out);
      for (const e of v) out.push(resolve(e));
      return out;
    }
    if (v && typeof v === 'object') {
      const out = {};
      seen.set(ref, out);
      for (const [k, valueRef] of Object.entries(v)) out[resolve(Number(k.slice(1)))] = resolve(valueRef);
      return out;
    }
    seen.set(ref, v);
    return v;
  };
  return resolve(0);
}

const LOADERS = {
  models: '/loaders/list-models.data?_routes=routes%2Floaders%2Flist-models',
  conversations: '/loaders/list-conversations.data?_routes=routes%2Floaders%2Flist-converstaions',
  usage: '/loaders/get-usage-quota',
};

// list-models carries no field separating chat models from image/video/audio
// generators, so exclude those by id. AIPASS_MODEL_FILTER=all keeps them.
const MEDIA_ID = /(seedream|seedance|veo-|lyria|gpt-image|-image$|image-preview)/i;
const MODEL_FILTER = process.env.AIPASS_MODEL_FILTER ?? 'chat';

function extractModels(decoded) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    const id = v.id ?? v.modelId;
    if (typeof id === 'string' && id && !out.some((m) => m.id === id)) {
      out.push({
        id,
        name: v.displayName ?? v.name ?? id,
        provider: v.providerName ?? v.provider ?? null,
        free: v.isFreeCredit === true,
        ready: v.ready !== false,
        thinking: Array.isArray(v.thinkingConfig?.supportedLevels) ? v.thinkingConfig.supportedLevels : null,
        media: MEDIA_ID.test(id),
      });
    }
    Object.values(v).forEach(walk);
  };
  walk(decoded);
  return MODEL_FILTER === 'all' ? out : out.filter((m) => !m.media && m.ready);
}

/* ---------------------------------------------------------------- job hub */

const jobs = new Map();
const extClients = new Set();
// Broadcast dispatch replaced round-robin pickClient/rr: zombie SSE connections
// from evicted workers would otherwise steal every other job.
let pollRr = 0;

const sendToClient = (client, event, data) =>
  client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

class Job {
  constructor({ kind = 'chat', modelId, text, conversationId, url, message, requestId, assistant, assistantField, timeoutMs, onDelta, onDone, onError }) {
    this.id = randomUUID();
    this.kind = kind;
    this.url = url;
    this.message = message;
    this.requestId = requestId;
    this.assistant = assistant;
    this.assistantField = assistantField;
    this.timeoutMs = timeoutMs ?? IDLE_TIMEOUT_MS;
    this.modelId = modelId;
    this.text = text;
    this.conversationId = conversationId;
    this.onDelta = onDelta;
    this.onDone = onDone;
    this.onError = onError;
    this.settled = false;
    this.touch();
    jobs.set(this.id, this);
  }
  touch() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail('timed out waiting for the extension'), this.timeoutMs);
  }
  payload() {
    return this.kind === 'loader'
      ? { jobId: this.id, kind: 'loader', url: this.url }
      : this.kind === 'create'
      ? { jobId: this.id, kind: 'create', modelId: this.modelId, message: this.message, requestId: this.requestId, assistant: this.assistant, assistantField: this.assistantField }
      : { jobId: this.id, kind: 'chat', conversationId: this.conversationId, modelId: this.modelId, text: this.text };
  }
  dispatch() {
    if (!extClients.size) return this.fail('no extension connected — open a de.aipass.net tab and check the popup');
    // Broadcast, not round-robin: a zombie SSE from an evicted worker stays
    // in extClients until the kernel closes it, and rr++ would hand every
    // other job to that black hole. The extension dedupes via seenJobs, so
    // multiple deliveries are safe.
    for (const client of extClients) {
      this.client = client;
      sendToClient(client, 'job', this.payload());
    }
  }
  delta(part) { if (!this.settled) { this.touch(); this.onDelta(part); } }
  done(value) { if (this.settled) return; this.cleanup(); this.onDone(value ?? 'stop'); }
  fail(message) { if (this.settled) return; this.cleanup(); this.onError(message); }
  abort() {
    if (this.settled) return;
    if (this.client) sendToClient(this.client, 'abort', { jobId: this.id });
    this.cleanup();
  }
  cleanup() { this.settled = true; clearTimeout(this.timer); jobs.delete(this.id); }
}

// A discarded tab must reload (15s load wait) before the page can run the
// loader fetch; 20s died on that path every time. 45s covers reload+fetch.
const fetchLoader = (url, timeoutMs = 45_000) =>
  new Promise((resolve, reject) => {
    const job = new Job({ kind: 'loader', url, timeoutMs, onDelta: () => {}, onDone: resolve, onError: (m) => reject(new Error(m)) });
    job.dispatch();
  });

/* ------------------------------------------------------------------ models */

let modelCache = { at: 0, models: [] };
let modelRefresh = null;
const MODEL_TTL_MS = 60_000;

const cachedModels = () =>
  modelCache.models.length
    ? modelCache.models
    : MODELS_FALLBACK.map((id) => ({ id, name: id, provider: null, free: false, ready: true, thinking: null }));

async function listModels({ force = false } = {}) {
  if (!force && modelCache.models.length && Date.now() - modelCache.at < MODEL_TTL_MS) return modelCache.models;
  if (!extClients.size) return cachedModels();
  if (modelRefresh) return modelRefresh; // several callers can race; only one should hit the API
  modelRefresh = (async () => {
    try {
      const models = extractModels(decodeTurboStream(await fetchLoader(LOADERS.models)));
      if (models.length) {
        modelCache = { at: Date.now(), models };
        const free = models.filter((m) => m.free).map((m) => m.id);
        log(`${models.length} models${free.length ? ` (free credit: ${free.join(', ')})` : ''}`);
      }
    } catch (err) {
      log('model refresh failed:', err.message);
    } finally {
      modelRefresh = null;
    }
    return cachedModels();
  })();
  return modelRefresh;
}

/* ------------------------------------------------------------------ usage */

// The public frontend reads only creditStatus.credits.available|limit and
// creditStatus.periodEndsAt. Keep that narrow path; unrelated numbers in the
// loader payload must never become usage. `creditsDecimals` controls display
// precision, not numeric scaling.
function extractQuota(decoded) {
  let cs = null;
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    if (!cs && v.creditStatus && typeof v.creditStatus === 'object') cs = v.creditStatus;
    Object.values(v).forEach(walk);
  };
  walk(decoded);
  const available = Number(cs?.credits?.available);
  if (!Number.isFinite(available)) return null;

  const limit = 10_000;
  const remaining = Math.min(limit, Math.max(0, available));
  const used = limit - remaining;
  const resetMs = Date.parse(cs.periodEndsAt ?? '');
  return {
    limit,
    remaining,
    used,
    usedPercent: used / limit * 100,
    resetsAt: Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null,
  };
}

async function usageQuota() {
  if (!extClients.size) throw new Error('no extension connected — cannot read usage');
  const quota = extractQuota(decodeTurboStream(await fetchLoader(LOADERS.usage)));
  if (!quota) throw new Error('usage data unavailable');
  return quota;
}

/* ----------------------------------------------------------- conversations */

// Conversations are created by the server; posting to an invented id is
// rejected. Reuse the most recent, and move on if one stops accepting messages.
// State is per API key, so each client session gets its own upstream
// conversation instead of sharing one.
const convState = new Map();
// isolated: created by mintKey — never falls through to account-wide history.
const stateFor = (key) => {
  let s = convState.get(key);
  if (!s) {
    const isolated = isMintedKey(key);
    convState.set(key, (s = {
      cache: isolated ? conversationForKey(key) : null,
      list: [], index: 0, isolated,
    }));
  }
  return s;
};

async function loadConversations(key) {
  if (!extClients.size) throw new Error('no extension connected — cannot look up a conversation');
  const decoded = decodeTurboStream(await fetchLoader(LOADERS.conversations));
  const list = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== 'object') return;
    if (typeof v.id === 'string' && typeof v.updatedAt === 'string') list.push(v);
    Object.values(v).forEach(walk);
  };
  walk(decoded);
  list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  stateFor(key).list = list;
  return list;
}

function findValue(node, key) {
  if (Array.isArray(node)) {
    for (const v of node) { const hit = findValue(v, key); if (hit != null) return hit; }
    return null;
  }
  if (!node || typeof node !== 'object') return null;
  if (typeof node[key] === 'string') return node[key];
  for (const v of Object.values(node)) { const hit = findValue(v, key); if (hit != null) return hit; }
  return null;
}

// The chat page creates a conversation by posting its first message to
// /chat.data; the server derives the id from clientCreateRequestId.
async function createConversation(key, { modelId = defaultModel, message = 'Hello', assistant } = {}) {
  const requestId = randomUUID();
  const raw = await new Promise((resolve, reject) => {
    const job = new Job({
      kind: 'create', modelId, message, requestId,
      assistant: assistant ?? assistantId, assistantField: ASSISTANT_FIELD,
      timeoutMs: 30_000,
      onDelta: () => {}, onDone: resolve, onError: (m) => reject(new Error(m)),
    });
    job.dispatch();
  });
  const id = findValue(decodeTurboStream(raw), 'conversationId');
  if (!id) throw new Error('could not read a conversation id from the response');
  const s = stateFor(key);
  s.cache = id;
  s.index = 0;
  s.list = [];
  if (s.isolated) setConversationForKey(key, id);
  log('created conversation');
  return id;
}

async function resolveConversation(key) {
  if (PINNED_CONVERSATION) return PINNED_CONVERSATION;
  const s = stateFor(key);
  if (s.cache) return s.cache;
  // Isolated (minted) keys always get their own fresh upstream conversation —
  // never falling through to account-wide history.
  if (s.isolated) return createConversation(key, { modelId: defaultModel });
  if (!s.list.length) await loadConversations(key);
  const pick = s.list[s.index];
  if (!pick) {
    // Fresh account or everything deleted: create one instead of failing.
    return createConversation(key, { modelId: defaultModel });
  }
  s.cache = pick.id;
  log('conversation selected from account history');
  return s.cache;
}

/* --------------------------------------------------------------- chat flow */

// A 404 means the conversation was deleted; a 409 means the server still
// believes a generation is running there. Neither recovers on its own.
function startChat({ key, modelId, text, onDelta, onDone, onError }) {
  let attempts = 0;
  let delivered = 0;
  let current = null;

  const attempt = async () => {
    attempts++;
    let conversationId;
    try { conversationId = await resolveConversation(key); }
    catch (err) { return onError(err.message); }

    current = new Job({
      modelId, text, conversationId,
      onDelta: (part) => { delivered++; onDelta(part); },
      onDone,
      onError: (message) => {
        const rejected = /conversation not found|returned 403|returned 404|returned 409/i.test(message);
        if (rejected && attempts <= 3 && delivered === 0 && !PINNED_CONVERSATION) {
          log('conversation rejected, trying the next one');
          const s = stateFor(key);
          s.index++;
          s.cache = null;
          if (s.isolated) setConversationForKey(key, null);
          attempt();
          return;
        }
        onError(message);
      },
    });
    current.dispatch();
  };

  attempt();
  return { abort: () => current?.abort() };
}

// Strip hook-injected <instructions>...</instructions> blocks that Claude Code
// prepends to user messages via UserPromptSubmit hooks. The actual user text
// follows the closing tag (or is in a separate content part after it).
function stripInjectedInstructions(text) {
  // Remove every <instructions>...</instructions> block (potentially multi-line).
  return text.replace(/<instructions>[\s\S]*?<\/instructions>/g, '').trim();
}

// Only the newest user message is sent. The server holds the history, and a
// messages array containing an assistant turn is rejected upstream. A turn
// that is pure hook instructions strips to nothing; fall back to the newest
// turn that still carries real user text.
function lastUserText(messages) {
  const texts = (messages ?? [])
    .filter((m) => m.role === 'user')
    .map((m) => {
      const raw = typeof m.content === 'string'
        ? m.content
        : (m.content ?? []).map((p) => (p?.type === 'text' ? p.text : '')).join('');
      return stripInjectedInstructions(raw);
    })
    .filter((t) => t.trim());
  return texts.at(-1) ?? '';
}

/* ------------------------------------------------------------ http plumbing */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    ...corsHeaders(res.req?.headers.origin),
  });
  res.end(body);
}

const oaiError = (res, status, message, type = 'invalid_request_error', code = E.server_error) =>
  json(res, status, errorBody(code, message, type));

/* ---------------------------------------------------------- chat completions */

async function chatCompletions(req, res, key) {
  let payload;
  try { payload = JSON.parse(await readBody(req)); }
  catch { return oaiError(res, 400, 'invalid JSON body', 'invalid_request_error', E.server_error); }

  const model = String(payload.model ?? defaultModel).replace(/^aipass\//, '');
  const raw = lastUserText(payload.messages);
  if (!raw) return oaiError(res, 400, 'no user message', 'invalid_request_error', E.server_error);

  // Authoritative DLP boundary: strip secrets/PII before the text becomes a
  // Job the extension relays upstream. Counts only are logged, never values.
  const { text, counts } = redact(raw);
  const tally = Object.entries(counts);
  if (tally.length) log(`dlp -> ${tally.map(([k, n]) => `${k}:${n}`).join(' ')}`);

  const id = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  log(`chat -> ${model} (${Buffer.byteLength(text)} bytes)`);

  if (payload.stream) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...corsHeaders(req.headers.origin),
    });
    const emit = (delta, finish = null) => {
      res.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`);
    };
    emit({ role: 'assistant', content: '' });

    const job = startChat({
      key, modelId: model, text,
      onDelta: (part) => {
        if (part.kind === 'status') {
          if (TOOL_VISIBILITY === 'off') return;
          if (TOOL_VISIBILITY === 'text') emit({ content: `\n${part.text}\n` });
          else emit({ reasoning_content: `${part.text}\n` });
          return;
        }
        if (part.kind === 'reasoning') emit({ reasoning_content: part.text });
        else emit({ content: part.text });
      },
      onDone: (finishReason) => {
        emit({}, finishReason === 'length' ? 'length' : 'stop');
        res.write('data: [DONE]\n\n');
        res.end();
      },
      onError: (message) => {
        res.write(`data: ${JSON.stringify({ error: { message, type: 'upstream_error' } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      },
    });
    res.on('close', () => job.abort());
    return;
  }

  let out = '';
  let reasoning = '';
  await new Promise((resolve) => {
    const job = startChat({
      key, modelId: model, text,
      onDelta: (p) => {
        if (p.kind === 'status') { if (TOOL_VISIBILITY !== 'off') reasoning += `${p.text}\n`; return; }
        if (p.kind === 'reasoning') reasoning += p.text;
        else out += p.text;
      },
      onDone: (finishReason) => {
        json(res, 200, {
          id, object: 'chat.completion', created, model,
          choices: [{
            index: 0,
            message: { role: 'assistant', content: out, ...(reasoning ? { reasoning_content: reasoning } : {}) },
            finish_reason: finishReason === 'length' ? 'length' : 'stop',
          }],
          // Estimates: the upstream stream reports no token counts, but some
          // clients refuse a response without a usage block.
          usage: {
            prompt_tokens: Math.ceil(text.length / 4),
            completion_tokens: Math.ceil(out.length / 4),
            total_tokens: Math.ceil((text.length + out.length) / 4),
          },
        });
        resolve();
      },
      onError: (message) => { oaiError(res, 502, message, 'upstream_error', E.upstream_error); resolve(); },
    });
    res.on('close', () => { job.abort(); resolve(); });
  });
}

/* -------------------------------------------------------- extension channel */

function extEvents(req, res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    ...corsHeaders(req.headers.origin),
    'access-control-allow-private-network': 'true',
  });
  const client = { id: randomUUID(), res };
  extClients.add(client);
  log(`extension connected (${extClients.size} total)`);
  sendToClient(client, 'ready', { clientId: client.id });
  setTimeout(() => listModels({ force: true }).catch(() => {}), 500);

  const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    clearInterval(ping);
    extClients.delete(client);
    log(`extension disconnected (${extClients.size} left)`);
    // Do NOT fail in-flight jobs. The upstream fetch lives in the page and
    // survives the worker being evicted, which is exactly what happens during
    // a long web_search when no deltas flow to reset the worker's idle timer.
    for (const job of jobs.values()) if (job.client === client) job.client = null;
  });
}

async function extPost(req, res, kind) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { return json(res, 400, { ok: false }); }
  const job = jobs.get(body.jobId);
  if (!job) return json(res, 200, { ok: false, reason: 'unknown job' });
  if (kind === 'chunk') for (const part of body.parts ?? []) job.delta(part);
  else if (kind === 'done') job.done(body.finishReason);
  else if (kind === 'loader') {
    if (typeof body.raw === 'string') job.done(body.raw);
    else job.fail(body.message ?? 'loader fetch failed');
  } else job.fail(body.message ?? 'extension reported an error');
  return json(res, 200, { ok: true });
}

/* --------------------------------------------------------------- the server */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    const origin = req.headers.origin;
    if (!originAllowed(origin)) return rejectOrigin(res, origin);
    res.writeHead(204, preflightHeaders(origin));
    return res.end();
  }

  // Reject unrecognised web origins before auth runs.
  const origin = req.headers.origin;
  if (!originAllowed(origin)) return rejectOrigin(res, origin);

  // Minimal health probe is the sole unauthenticated route.
  if (path === '/health') return json(res, 200, { ok: true });

  // Every other route requires a valid Bearer key; key === the bearer string.
  const key = checkAuth(req);
  if (key === 'missing' || key === 'invalid') {
    return json(res, 401, errorBody(
      key === 'missing' ? E.auth_required : E.auth_invalid,
      key === 'missing' ? 'authorization header required' : 'invalid bearer token',
      'authentication_error',
    ));
  }

  try {
    if (path === '/keys' && req.method === 'POST') {
      // Mint a session key. Main token only; minted keys cannot mint more.
      // The key is returned once, never logged; it persists in the keys file.
      if (key !== loadToken()) return json(res, 403, { error: 'main token required' });
      const minted = mintKey();
      convState.set(minted, { cache: null, list: [], index: 0, isolated: true });
      return json(res, 200, { key: minted });
    }

    if (path === '/v1/chat/completions' && req.method === 'POST') return await chatCompletions(req, res, key);

    if (path === '/v1/usage' && req.method === 'GET') {
      try { return json(res, 200, await usageQuota()); }
      catch { return oaiError(res, 502, 'usage data unavailable', 'upstream_error', E.upstream_error); }
    }

    if (path === '/v1/models') {
      const models = await listModels({ force: url.searchParams.get('refresh') === '1' });
      return json(res, 200, {
        object: 'list',
        data: models.map((m) => ({
          id: m.id, object: 'model', created: 0, owned_by: m.provider ?? 'aipass',
          name: m.name, free_credit: m.free, thinking: m.thinking,
        })),
      });
    }

    if (path === '/conversations/new' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      const id = await createConversation(key, { modelId: body.model, message: body.message, assistant: body.assistant });
      return json(res, 200, { id });
    }
    if (path === '/conversations') {
      await loadConversations(key).catch(() => {});
      const s = stateFor(key);
      return json(res, 200, {
        current: PINNED_CONVERSATION || s.cache,
        conversations: s.list.map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })),
      });
    }

    if (path === '/config' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req) || '{}');
      if (typeof body.defaultModel === 'string' && body.defaultModel.trim()) {
        defaultModel = body.defaultModel.trim();
        log(`default model ${defaultModel}`);
      }
      if (typeof body.assistant === 'string') { assistantId = body.assistant.trim(); log(assistantId ? `assistant ${assistantId}` : 'assistant cleared'); }
      if (body.conversation === null || typeof body.conversation === 'string') {
        const s = stateFor(key);
        s.cache = body.conversation || null;
        s.index = 0;
        if (!s.cache) s.list = [];
        if (s.isolated) setConversationForKey(key, s.cache);
        log(s.cache ? 'conversation set' : 'conversation cleared');
      }
      const s = stateFor(key);
      return json(res, 200, { ok: true, defaultModel, assistant: assistantId || null, conversation: PINNED_CONVERSATION || s.cache });
    }

    if (path === '/ext/events' && req.method === 'GET') return extEvents(req, res);
    if (path === '/ext/poll' && req.method === 'GET') {
      // Pull fallback for MV3 workers suspended mid-SSE. Repeating a pending
      // job is safe: the extension deduplicates successful dispatches, while a
      // worker that dies before dispatch must not claim the job permanently.
      const pending = [...jobs.values()];
      const job = pending.length ? pending[pollRr++ % pending.length] : null;
      return json(res, 200, { job: job?.payload() ?? null });
    }
    if (path === '/ext/chunk' && req.method === 'POST') return await extPost(req, res, 'chunk');
    if (path === '/ext/done' && req.method === 'POST') return await extPost(req, res, 'done');
    if (path === '/ext/error' && req.method === 'POST') return await extPost(req, res, 'error');
    if (path === '/ext/loader' && req.method === 'POST') return await extPost(req, res, 'loader');

    if (path === '/status') {
      const s = stateFor(key);
      return json(res, 200, {
        ok: true,
        extensions: extClients.size,
        activeJobs: jobs.size,
        defaultModel,
        conversation: PINNED_CONVERSATION || s.cache,
        assistant: assistantId || null,
        models: cachedModels(),
      });
    }

    return oaiError(res, 404, 'route not found', 'not_found', E.not_found);
  } catch (err) {
    log('unhandled', err);
    if (!res.headersSent) oaiError(res, 500, 'internal server error', 'server_error', E.server_error);
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  loadToken();
  log(`aipass bridge on http://${HOST}:${PORT}`);
  log(`  default model : ${defaultModel}`);
  log(`  conversation  : ${PINNED_CONVERSATION || 'most recent on the account'}`);
  if (!process.env.AIPASS_TOKEN) log(`  auth token    : ${tokenFilePath()} (all routes except /health)`);
  else log('  auth token    : AIPASS_TOKEN env');
  log('  waiting for the Chrome extension…');
});
