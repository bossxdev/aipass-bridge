import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startBridge, FakeExtension, scripted, tempDir, waitFor,
  encodeTurboStream, usageFixture,
} from './harness.mjs';

let bridge;
before(async () => { bridge = await startBridge(); });
after(() => bridge.stop());

const auth = () => ({ authorization: `Bearer ${bridge.token}` });

const keyedAuth = (key = bridge.token) => ({ authorization: `Bearer ${key}` });

const post = (body, key = bridge.token) => fetch(`${bridge.base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...keyedAuth(key) },
  body: JSON.stringify(body),
});

async function readStream(res) {
  const text = await res.text();
  const frames = text.split('\n\n')
    .map((f) => f.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join(''))
    .filter((d) => d && d !== '[DONE]')
    .map((d) => JSON.parse(d));
  return {
    content: frames.map((f) => f.choices?.[0]?.delta?.content ?? '').join(''),
    reasoning: frames.map((f) => f.choices?.[0]?.delta?.reasoning_content ?? '').join(''),
    finish: frames.map((f) => f.choices?.[0]?.finish_reason).filter(Boolean).at(-1),
    error: frames.find((f) => f.error)?.error,
    done: text.includes('data: [DONE]'),
  };
}

test('refuses a request with no extension attached', async () => {
  const res = await post({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error.code, 'upstream_error');
  assert.match(body.error.message, /no extension connected/);
});

test('returns stable error codes without echoing request routes', async () => {
  const bad = await fetch(`${bridge.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${bridge.token}` },
    body: '{',
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'server_error');

  const missing = await fetch(`${bridge.base}/path-containing-secret-value`, {
    headers: { authorization: `Bearer ${bridge.token}` },
  });
  assert.equal(missing.status, 404);
  const body = await missing.json();
  assert.equal(body.error.code, 'not_found');
  assert.equal(body.error.message, 'route not found');
  assert.doesNotMatch(JSON.stringify(body), /secret-value/);
});

test('streams text, tool status and a finish reason', async () => {
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (_job, e) => {
      await e.status('[web_search] {"query":"x"}');
      await e.text('hello ');
      await e.text('world');
      await e.status('sources:\n  - X https://example.com');
      await e.done();
    },
  }).connect();

  const out = await readStream(await post({ stream: true, messages: [{ role: 'user', content: 'hi' }] }));
  assert.equal(out.content, 'hello world');
  assert.match(out.reasoning, /web_search/);
  assert.match(out.reasoning, /sources:/);
  assert.equal(out.finish, 'stop');
  assert.ok(out.done);
  await ext.disconnect();
});

test('forwards only the newest user message, never an assistant turn', async () => {
  const handler = scripted(['ok']);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();

  await post({
    messages: [
      { role: 'system', content: 'SYSTEM PROMPT' },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: 'the newest question' },
    ],
  });

  assert.equal(handler.sent.at(-1), 'the newest question');
  assert.doesNotMatch(handler.sent.at(-1), /SYSTEM PROMPT|earlier answer|first question/);
  await ext.disconnect();
});

test('strips injected <instructions> blocks before forwarding to the extension', async () => {
  const handler = scripted(['ok']);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();

  await post({
    messages: [
      { role: 'user', content: '<instructions>\nsome hook output\n</instructions>\n\nactual user question' },
    ],
  });

  assert.equal(handler.sent.at(-1), 'actual user question');
  assert.doesNotMatch(handler.sent.at(-1), /<instructions>/);
  await ext.disconnect();
});

test('strips instructions block from multi-part content array', async () => {
  const handler = scripted(['ok']);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();

  await post({
    messages: [
      { role: 'user', content: [{ type: 'text', text: '<instructions>\nhook\n</instructions>\n\nreal question' }] },
    ],
  });

  assert.equal(handler.sent.at(-1), 'real question');
  assert.doesNotMatch(handler.sent.at(-1), /<instructions>/);
  await ext.disconnect();
});

test('falls back to an earlier user turn when the newest strips to empty', async () => {
  const handler = scripted(['ok']);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();

  await post({
    messages: [
      { role: 'user', content: 'the real question' },
      { role: 'user', content: '<instructions>\nonly hook output here\n</instructions>\n' },
    ],
  });

  assert.equal(handler.sent.at(-1), 'the real question');
  await ext.disconnect();
});

test('non-streaming returns a complete message with usage', async () => {
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (_j, e) => { await e.text('the answer'); await e.done(); },
  }).connect();

  const body = await (await post({ messages: [{ role: 'user', content: 'hi' }] })).json();
  assert.equal(body.choices[0].message.content, 'the answer');
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.ok(body.usage.total_tokens > 0);
  await ext.disconnect();
});

test('rejects a request carrying no user message', async () => {
  const ext = await new FakeExtension(bridge.base).connect();
  const res = await post({ messages: [{ role: 'system', content: 'only a system turn' }] });
  assert.equal(res.status, 400);
  await ext.disconnect();
});

test('discovers models, marks free credit, and drops media generators', async () => {
  const ext = await new FakeExtension(bridge.base).connect();
  await waitFor(async () => (await (await fetch(`${bridge.base}/v1/models?refresh=1`, { headers: { authorization: `Bearer ${bridge.token}` } })).json()).data.length > 1);

  const { data } = await (await fetch(`${bridge.base}/v1/models`, { headers: { authorization: `Bearer ${bridge.token}` } })).json();
  const ids = data.map((m) => m.id);
  assert.ok(ids.includes('gemini-3.1-flash-lite'));
  assert.ok(ids.includes('claude-sonnet-5@default'));
  assert.ok(!ids.includes('veo-3.1-fast-generate-001'), 'video model should be filtered out');
  assert.equal(data.find((m) => m.id === 'gemini-3.1-flash-lite').free_credit, true);
  await ext.disconnect();
});

test('picks the most recent conversation and rotates past one that is locked', async () => {
  const seen = [];
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (job, e) => {
      seen.push(job.conversationId);
      if (job.conversationId === 'aaaa1111aaaa1111') return void e.error('aipass returned 409 — {"detail":"Conversation is busy"}');
      await e.text('ok');
      await e.done();
    },
  }).connect();

  await fetch(`${bridge.base}/config`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...auth() }, body: JSON.stringify({ conversation: null }),
  });

  const body = await (await post({ messages: [{ role: 'user', content: 'hi' }] })).json();
  assert.equal(body.choices[0].message.content, 'ok');
  assert.deepEqual(seen, ['aaaa1111aaaa1111', 'bbbb2222bbbb2222'], 'should try newest first, then the next');
  await ext.disconnect();
});

test('a job survives the extension disconnecting mid-stream', async () => {
  let resume;
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (job, e) => {
      await e.text('part one ');
      await ext.disconnect();                       // the worker gets evicted
      resume = async () => {
        const back = await new FakeExtension(bridge.base).connect();
        await e.text('part two');             // delivery resumes on the same job
        await e.done();
        return back;
      };
    },
  }).connect();

  const pending = post({ stream: true, messages: [{ role: 'user', content: 'hi' }] });
  await waitFor(() => typeof resume === 'function');
  const back = await resume();

  const out = await readStream(await pending);
  assert.equal(out.content, 'part one part two');
  assert.equal(out.finish, 'stop');
  await back.disconnect();
});

test('config sets the default model and reports it', async () => {
  const handler = scripted(['ok']);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();

  await fetch(`${bridge.base}/config`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...auth() },
    body: JSON.stringify({ defaultModel: 'claude-sonnet-5@default' }),
  });
  await post({ messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(ext.chats.at(-1).modelId, 'claude-sonnet-5@default');
  const status = await (await fetch(`${bridge.base}/status`, { headers: auth() })).json();
  assert.equal(status.defaultModel, 'claude-sonnet-5@default');
  await ext.disconnect();
});

test('surfaces an upstream error inside the stream', async () => {
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (_j, e) => e.error('aipass returned 403 — 403 Forbidden'),
  }).connect();

  const out = await readStream(await post({ stream: true, messages: [{ role: 'user', content: 'hi' }] }));
  assert.match(out.error.message, /403/);
  assert.ok(out.done, 'the stream must still terminate cleanly');
  await ext.disconnect();
});

test('passes an assistant id and field through to the create call', async (t) => {
  const ext = await new FakeExtension(bridge.base).connect();
  t.after(() => ext.disconnect());

  const made = await (await fetch(`${bridge.base}/conversations/new`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...auth() },
    body: JSON.stringify({ message: 'hi', assistant: 'asst_xyz' }),
  })).json();

  assert.match(made.id, /^[0-9a-f]{16}$/);
  assert.equal(ext.created.at(-1).assistant, 'asst_xyz');
  assert.equal(ext.created.at(-1).assistantField, 'aiAssistantId', 'default field name until a capture confirms it');
});

test('creates a conversation and adopts it', async (t) => {
  const ext = await new FakeExtension(bridge.base).connect();
  t.after(() => ext.disconnect());

  const made = await (await fetch(`${bridge.base}/conversations/new`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...auth() },
    body: JSON.stringify({ message: 'สวัสดี', model: 'gemini-3.1-flash-lite' }),
  })).json();

  assert.match(made.id, /^[0-9a-f]{16}$/);
  assert.equal(ext.created.length, 1);
  assert.equal(ext.created[0].message, 'สวัสดี');
  assert.equal(ext.created[0].modelId, 'gemini-3.1-flash-lite');
  // the server derives the id from the request id it was handed
  assert.equal(made.id, ext.created[0].requestId.replace(/-/g, '').slice(0, 16));

  const status = await (await fetch(`${bridge.base}/status`, { headers: auth() })).json();
  assert.equal(status.conversation, made.id, 'the new conversation becomes the current one');

  await post({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(ext.chats.at(-1).conversationId, made.id, 'chats go to the new conversation');
});

// ------------------------------------------------------------------- usage

test('/v1/usage requires auth and reports normalized quota', async (t) => {
  const unauth = await fetch(`${bridge.base}/v1/usage`);
  assert.equal(unauth.status, 401);

  const ext = await new FakeExtension(bridge.base, {
    onLoader: (job) => (job.url.includes('get-usage-quota')
      ? usageFixture({ available: '7500', limit: '10000', periodEndsAt: '2026-09-04T23:59:59.000Z' })
      : undefined),
  }).connect();
  // undefined falls through to the default fixtures; only quota is scripted.
  t.after(() => ext.disconnect());

  const r = await fetch(`${bridge.base}/v1/usage`, { headers: auth() });
  assert.equal(r.status, 200);
  const q = await r.json();
  assert.equal(q.limit, 10000);
  assert.equal(q.remaining, 7500);
  assert.equal(q.used, 2500);
  assert.equal(q.usedPercent, 25);
  assert.equal(q.resetsAt, '2026-09-04T23:59:59.000Z');
  assert.ok(ext.loaders.some((u) => u.includes('get-usage-quota')), 'quota goes through the loader channel');
});

test('/v1/usage clamps and survives odd upstream values', async (t) => {
  const cases = [
    { in: { available: '12000' }, out: { remaining: 10000, used: 0, usedPercent: 0 } },   // over limit
    { in: { available: '-5' }, out: { remaining: 0, used: 10000, usedPercent: 100 } },    // negative
    { in: { available: 3250.5 }, out: { remaining: 3250.5, used: 6749.5, usedPercent: 67.495 } }, // number, no reset
  ];
  let i = 0;
  const ext = await new FakeExtension(bridge.base, {
    onLoader: (job) => (job.url.includes('get-usage-quota')
      ? usageFixture(cases[i].in)
      : undefined),
  }).connect();
  t.after(() => ext.disconnect());

  for (i = 0; i < cases.length; i++) {
    const q = await (await fetch(`${bridge.base}/v1/usage`, { headers: auth() })).json();
    assert.equal(q.remaining, cases[i].out.remaining);
    assert.equal(q.used, cases[i].out.used);
    assert.equal(q.usedPercent, cases[i].out.usedPercent);
    assert.equal(q.resetsAt, null);
  }
});

test('/v1/usage fails closed on malformed or unavailable data', async (t) => {
  // no extension
  const noExt = await fetch(`${bridge.base}/v1/usage`, { headers: auth() });
  assert.equal(noExt.status, 502);
  const body = await noExt.json();
  assert.match(body.error.message, /usage data unavailable/);
  assert.doesNotMatch(JSON.stringify(body), /creditStatus|"available"|"limit"/, 'no upstream data echoed');

  const ext = await new FakeExtension(bridge.base, {
    onLoader: (job) => (job.url.includes('get-usage-quota') ? encodeTurboStream({ data: { success: false } }) : undefined),
  }).connect();
  t.after(() => ext.disconnect());

  const bad = await fetch(`${bridge.base}/v1/usage`, { headers: auth() });
  assert.equal(bad.status, 502);
  assert.match((await bad.json()).error.message, /usage data unavailable/);

  const logs = bridge.logText();
  assert.doesNotMatch(logs, /creditStatus|credits/, 'no quota payload leaked into logs');
});

// ---------------------------------------------------------------- multi-key

async function mintKey() {
  const r = await fetch(`${bridge.base}/keys`, { method: 'POST', headers: auth() });
  assert.equal(r.status, 200);
  return (await r.json()).key;
}

test('minted keys authenticate and are rejected when wrong', async (t) => {
  const ext = await new FakeExtension(bridge.base, { onChat: scripted(['ok']) }).connect();
  t.after(() => ext.disconnect());

  const key = await mintKey();
  const body = await (await post({ messages: [{ role: 'user', content: 'hi' }] }, key)).json();
  assert.equal(body.choices[0].message.content, 'ok');

  const bad = await post({ messages: [{ role: 'user', content: 'hi' }] }, key.slice(0, -1) + '0');
  assert.equal(bad.status, 401);
});

test('minted keys cannot mint further keys', async () => {
  const key = await mintKey();
  const r = await fetch(`${bridge.base}/keys`, { method: 'POST', headers: keyedAuth(key) });
  assert.equal(r.status, 403);
});

test('two minted keys get distinct upstream conversations', async (t) => {
  const handler = scripted(['ok']);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  const k1 = await mintKey();
  const k2 = await mintKey();

  await post({ messages: [{ role: 'user', content: 'one' }] }, k1);
  await post({ messages: [{ role: 'user', content: 'two' }] }, k2);

  const c1 = ext.chats.at(-2).conversationId;
  const c2 = ext.chats.at(-1).conversationId;
  assert.notEqual(c1, c2, 'each key must own its own conversation');
  assert.ok(ext.created.length >= 2, 'both conversations were created fresh, not reused');

  // follow-ups stay in the assigned conversation
  await post({ messages: [{ role: 'user', content: 'again' }] }, k1);
  assert.equal(ext.chats.at(-1).conversationId, c1);
});

test('main token keeps reusing the newest account conversation', async (t) => {
  const handler = scripted(['ok']);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  await fetch(`${bridge.base}/config`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...auth() }, body: JSON.stringify({ conversation: null }),
  });

  const body = await (await post({ messages: [{ role: 'user', content: 'hi' }] })).json();
  assert.equal(body.choices[0].message.content, 'ok');
  assert.equal(ext.chats.at(-1).conversationId, 'aaaa1111aaaa1111', 'legacy behaviour: newest account conversation');
  assert.equal(ext.created.length, 0, 'no conversation created for the main token');
});

test('clearing the conversation on one minted key does not affect the other', async (t) => {
  const handler = scripted(['ok']);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  const k1 = await mintKey();
  const k2 = await mintKey();

  await post({ messages: [{ role: 'user', content: 'one' }] }, k1);
  const c1 = ext.chats.at(-1).conversationId;

  await fetch(`${bridge.base}/config`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...keyedAuth(k1) }, body: JSON.stringify({ conversation: null }),
  });

  const status1 = await (await fetch(`${bridge.base}/status`, { headers: keyedAuth(k1) })).json();
  assert.equal(status1.conversation, null);

  const status2 = await (await fetch(`${bridge.base}/status`, { headers: keyedAuth(k2) })).json();
  assert.equal(status2.conversation, null, 'k2 has not been used yet either');

  // k1 clear → next use creates a NEW conversation, not k2's and not an account one
  await post({ messages: [{ role: 'user', content: 'fresh' }] }, k1);
  const c1new = ext.chats.at(-1).conversationId;
  assert.notEqual(c1new, c1, 'clearing an isolated key must not reuse its own old conversation');
});

test('a rejected conversation on a minted key creates a fresh one', async (t) => {
  // reject the first conversation a key uses, then accept the replacement
  let first = true;
  const handler = async (job, e) => {
    if (first) { first = false; return void e.error('conversation not found'); }
    await e.text('ok');
    await e.done();
  };
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  const k = await mintKey();
  const out = await readStream(await post({ stream: true, messages: [{ role: 'user', content: 'hi' }] }, k));
  assert.equal(out.content, 'ok');
  assert.equal(ext.created.length, 2, 'rejection on an isolated key creates a new conversation, not account rotation');
});

test('keys and conversation ids never appear in logs', async (t) => {
  const handler = scripted(['ok']);
  const ext = await new FakeExtension(bridge.base, { onChat: handler }).connect();
  t.after(() => ext.disconnect());

  const key = await mintKey();
  await post({ messages: [{ role: 'user', content: 'hi' }] }, key);
  await waitFor(() => ext.chats.length > 0);

  const logs = bridge.logText();
  assert.doesNotMatch(logs, new RegExp(key), 'minted key must not be logged');
  assert.doesNotMatch(logs, new RegExp(ext.chats.at(-1).conversationId), 'conversation id must not be logged');
  assert.ok(logs.length > 0, 'the bridge does log something (sanity)');
});

test('minted keys survive a bridge restart', async (t) => {
  const keysFile = `${tempDir()}/keys`;
  const mainToken = 'restart-test-main-token';
  const env = { AIPASS_KEYS_FILE: keysFile, AIPASS_TOKEN: mainToken };

  const b2 = await startBridge(env);
  const minted = await fetch(`${b2.base}/keys`, {
    method: 'POST', headers: { authorization: `Bearer ${mainToken}` },
  });
  assert.equal(minted.status, 200);
  const key = (await minted.json()).key;
  b2.stop(); // SIGKILL — mint must have flushed key synchronously

  const b3 = await startBridge(env);
  t.after(() => b3.stop());
  const status = await fetch(`${b3.base}/status`, {
    headers: { authorization: `Bearer ${key}` },
  });
  assert.equal(status.status, 200, 'persisted key authenticates after restart');
});

test('a minted key resumes its conversation across restarts, and a deleted one is replaced', async (t) => {
  const keysFile = `${tempDir()}/keys`;
  const mainToken = 'restart-continuity-main-token';
  const env = { AIPASS_KEYS_FILE: keysFile, AIPASS_TOKEN: mainToken };

  // First life: mint, chat, capture the conversation the key owns.
  const b1 = await startBridge(env);
  const handler = scripted(['ok']);
  const ext1 = await new FakeExtension(b1.base, { onChat: handler, token: mainToken }).connect();
  const key = (await (await fetch(`${b1.base}/keys`, {
    method: 'POST', headers: { authorization: `Bearer ${mainToken}` },
  })).json()).key;
  const r1 = await fetch(`${b1.base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'first' }] }),
  });
  assert.equal((await r1.json()).choices[0].message.content, 'ok');
  const original = ext1.chats.at(-1).conversationId;
  assert.ok(original);
  const otherKey = (await (await fetch(`${b1.base}/keys`, {
    method: 'POST', headers: { authorization: `Bearer ${mainToken}` },
  })).json()).key;
  await fetch(`${b1.base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${otherKey}` },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'other' }] }),
  });
  const otherConversation = ext1.chats.at(-1).conversationId;
  assert.notEqual(otherConversation, original);
  await ext1.disconnect();
  b1.stop(); // SIGKILL: mappings must already be flushed

  // Second life: same keys file → same conversation, no new create job.
  const b2 = await startBridge(env);
  const rejected = new Set([original]);
  const handler2 = async (job, e) => {
    if (rejected.has(job.conversationId)) return void e.error('conversation not found');
    await e.text('ok'); await e.done();
  };
  const ext2 = await new FakeExtension(b2.base, { onChat: handler2, token: mainToken }).connect();
  t.after(() => ext2.disconnect());

  const status = await (await fetch(`${b2.base}/status`, { headers: { authorization: `Bearer ${key}` } })).json();
  assert.equal(status.conversation, original, 'mapping restored before any chat');

  const r2 = await fetch(`${b2.base}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'second' }] }),
  });
  assert.equal((await r2.json()).choices[0].message.content, 'ok');
  assert.equal(ext2.created.length, 1, 'deleted conversation was replaced with a fresh one');
  const replacement = ext2.created.at(-1).requestId.replace(/-/g, '').slice(0, 16);
  assert.equal(ext2.chats.at(-1).conversationId, replacement, 'retry landed in the new conversation');

  // Third life: replacement must now be the persisted mapping.
  b2.stop();
  const b3 = await startBridge(env);
  t.after(() => b3.stop());
  const status3 = await (await fetch(`${b3.base}/status`, { headers: { authorization: `Bearer ${key}` } })).json();
  assert.equal(status3.conversation, replacement, 'replacement survives another restart');
  const otherStatus = await (await fetch(`${b3.base}/status`, { headers: { authorization: `Bearer ${otherKey}` } })).json();
  assert.equal(otherStatus.conversation, otherConversation, 'replacing one key leaves other mappings untouched');
});
