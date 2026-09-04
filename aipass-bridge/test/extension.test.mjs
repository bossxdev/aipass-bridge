import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');

function load({ fetch, sendMessage = async () => ({ ok: true }), query = async () => [], create } = {}) {
  const noopEvent = { addListener() {}, removeListener() {} };
  const chrome = {
    storage: { local: {
      get: async (key) => key === 'bridgeUrl'
        ? { bridgeUrl: 'http://127.0.0.1:8788' }
        : { token: 'secret-test-token' },
      set: async () => {},
    } },
    windows: {
      create: async (props) => {
        const tab = { id: 42, status: 'complete', discarded: false, url: props?.url, windowId: 7 };
        create?.({ url: props?.url }); // record like tabs.create did
        return { tabs: [tab] };
      },
    },
    tabs: {
      sendMessage,
      query,
      create,
      reload: async () => {},
      onUpdated: noopEvent,
    },
    scripting: { executeScript: async () => {} },
    runtime: {
      onConnect: noopEvent,
      onMessage: noopEvent,
      onStartup: noopEvent,
      onInstalled: noopEvent,
    },
    alarms: { create() {}, onAlarm: noopEvent },
  };
  const context = {
    __AIPASS_BRIDGE_TEST__: true,
    chrome,
    fetch,
    setTimeout,
    clearTimeout,
    AbortController,
    TextDecoder,
    console,
  };
  vm.runInNewContext(source, context, { filename: 'background.js' });
  return { api: context.__aipassBridgeTest, chrome };
}

test('readiness retries until MAIN-world page responds', async () => {
  let calls = 0;
  const { api } = load({
    fetch: async () => new Response(null, { status: 204 }),
    sendMessage: async () => ({ ok: ++calls >= 3 }),
  });

  await api.ensureContentScript({ id: 7, status: 'complete', discarded: false });
  assert.equal(calls, 3);
});

test('result POST retries transient non-2xx response', async () => {
  let calls = 0;
  const { api } = load({
    fetch: async () => new Response(null, { status: ++calls === 1 ? 503 : 204 }),
  });

  assert.equal(await api.post('/ext/done', { jobId: 'job-1' }), true);
  assert.equal(calls, 2);
});

test('final POST failure exposes path and status only', async () => {
  let calls = 0;
  const { api } = load({
    fetch: async () => { calls += 1; return new Response('sensitive response', { status: 401 }); },
  });

  assert.equal(await api.post('/ext/error', { message: 'sensitive request' }), false);
  assert.equal(calls, 3);
  assert.equal(api.status().lastError, 'bridge POST /ext/error returned 401');
  assert.doesNotMatch(api.status().lastError, /secret|sensitive|token/i);
});

test('job with no chat tab fails without creating one', async () => {
  const created = [];
  const errors = [];
  const { api } = load({
    fetch: async (url, opts) => {
      const body = JSON.parse(opts?.body ?? '{}');
      if (String(url).endsWith('/ext/error')) errors.push(body);
      return new Response(null, { status: 204 });
    },
    query: async () => [],
    create: async (props) => { created.push(props); return { id: 42, status: 'complete', discarded: false }; },
  });

  await api.handleJob({ jobId: 'job-2' });

  assert.equal(created.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /could not open a de\.aipass\.net tab/);
});

test('duplicate poll delivery dispatches a job only once', async () => {
  let runs = 0;
  const { api } = load({
    fetch: async () => new Response(null, { status: 204 }),
    query: async () => [{ id: 7, status: 'complete', discarded: false, url: 'https://de.aipass.net/chat' }],
    sendMessage: async (_tabId, msg) => {
      if (msg?.type === 'run') runs += 1;
      return { ok: true };
    },
  });

  await api.handleJob({ jobId: 'job-3' });
  await api.handleJob({ jobId: 'job-3' });
  assert.equal(runs, 1);
});

test('failed dispatch reports error once, does not redispatch in same worker', async () => {
  let attempts = 0;
  const errors = [];
  const { api } = load({
    fetch: async (url, opts) => {
      const body = JSON.parse(opts?.body ?? '{}');
      if (String(url).endsWith('/ext/error')) errors.push(body);
      return new Response(null, { status: 204 });
    },
    query: async () => [{ id: 7, status: 'complete', discarded: false, url: 'https://de.aipass.net/chat' }],
    sendMessage: async (_tabId, msg) => {
      if (msg?.type === 'ping') return { ok: true };
      attempts += 1;
      throw new Error('worker lost');
    },
  });

  await api.handleJob({ jobId: 'job-4' });
  await api.handleJob({ jobId: 'job-4' });
  assert.equal(attempts, 1);
  assert.equal(errors.length, 1);
});
