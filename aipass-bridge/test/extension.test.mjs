import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');

function load({ fetch, sendMessage = async () => ({ ok: true }), query = async () => [], create } = {}) {
  const noopEvent = { addListener() {}, removeListener() {} };
  const chrome = {
    storage: { local: { get: async (key) => key === 'bridgeUrl'
      ? { bridgeUrl: 'http://127.0.0.1:8788' }
      : { token: 'secret-test-token' } } },
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

test('job with no chat tab creates one and dispatches into it', async () => {
  const created = [];
  const dispatched = [];
  const { api } = load({
    fetch: async () => new Response(null, { status: 204 }),
    query: async () => [],
    create: async (props) => {
      const tab = { id: 42, status: 'complete', discarded: false, url: props.url, ...props };
      created.push(tab.url);
      return tab;
    },
    sendMessage: async (tabId, msg) => {
      if (msg?.type === 'ping') return { ok: true };
      dispatched.push({ tabId, type: msg?.type });
      return { ok: true };
    },
  });

  await api.handleJob({ jobId: 'job-2' });

  assert.equal(created.length, 1);
  assert.equal(created[0], 'https://de.aipass.net/chat');
  assert.equal(dispatched.at(-1).tabId, 42);
  assert.equal(dispatched.at(-1).type, 'run');
});
