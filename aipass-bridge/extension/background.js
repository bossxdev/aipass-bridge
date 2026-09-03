// Service worker: holds the long-lived connection to the local bridge and
// routes each job into a de.aipass.net tab.
//
// The connection lives here rather than in the content script because an
// https:// page talking to http://127.0.0.1 runs into mixed-content and
// Private Network Access checks; an extension request with host_permissions
// does not.
const DEFAULT_BRIDGE = 'http://127.0.0.1:8787';
const RECONNECT_MS = 3000;
const CYCLE_MS = 4 * 60 * 1000; // reconnect before Chrome's long-request ceiling

let controller = null;
let connected = false;
let lastError = '';
const jobTabs = new Map();

const bridgeUrl = async () =>
  ((await chrome.storage.local.get('bridgeUrl')).bridgeUrl || DEFAULT_BRIDGE).trim();

// Bearer token set in the popup; every bridge call carries it.
// HTTP header values must be ISO-8859-1 (printable ASCII for bearer tokens).
// If the stored value contains characters outside that range, discard it so
// fetch() does not throw a "non ISO-8859-1 code point" error.
const bridgeToken = async () => {
  const raw = ((await chrome.storage.local.get('token')).token || '').trim();
  return /^[\x20-\x7E]*$/.test(raw) ? raw : '';
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function post(path, body) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(`${await bridgeUrl()}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${await bridgeToken()}` },
        body: JSON.stringify(body),
      });
      if (res.ok) return true;
      lastError = `bridge POST ${path} returned ${res.status}`;
    } catch {
      lastError = `bridge POST ${path} failed`;
    }
    if (attempt < 2) await delay(150 * (attempt + 1));
  }
  return false;
}

async function findChatTab() {
  const tabs = await chrome.tabs.query({ url: 'https://de.aipass.net/*' });
  if (!tabs.length) return null;
  const live = tabs.filter((t) => !t.discarded && t.status !== 'unloaded');
  const pool = live.length ? live : tabs;
  // Prefer a tab already sitting on a chat route.
  return pool.find((t) => t.url?.includes('/chat')) ?? pool[0];
}

function waitForComplete(tabId, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(onUpdated); reject(new Error('tab did not finish loading')); }, timeoutMs);
    function onUpdated(id, info) {
      if (id !== tabId || info.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

// A tab opened before the extension was loaded or reloaded has no content
// script in it, and Chrome's memory saver can discard one entirely. Rather
// than telling the user to reload, put the scripts back.
async function ensureContentScript(tab) {
  const ready = async (attempts = 4) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        if ((await chrome.tabs.sendMessage(tab.id, { type: 'ping' }))?.ok) return true;
      } catch { /* script absent or page not ready */ }
      if (attempt < attempts - 1) await delay(100 * (attempt + 1));
    }
    return false;
  };

  if (await ready()) return;

  if (tab.discarded || tab.status === 'unloaded') {
    await chrome.tabs.reload(tab.id);
    await waitForComplete(tab.id);
    if (await ready()) return;
  }

  // page.js first: content.js relays to it.
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: ['page.js'] });
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', files: ['content.js'] });
  if (!await ready()) throw new Error('page bridge did not become ready');
}

async function handleJob(job) {
  const tab = (await findChatTab())
    // After a reboot the watchdog may not have opened the tab yet; create it
    // instead of failing the job. Focused window keeps Chrome in the background.
    ?? (await chrome.tabs.create({ url: 'https://de.aipass.net/chat', active: false }));
  if (!tab) {
    await post('/ext/error', { jobId: job.jobId, message: 'could not open a de.aipass.net tab' });
    return;
  }
  jobTabs.set(job.jobId, tab.id);
  try {
    if (tab.status !== 'complete') await waitForComplete(tab.id).catch(() => {});
    await ensureContentScript(tab);
    await chrome.tabs.sendMessage(tab.id, { type: 'run', job });
  } catch (err) {
    jobTabs.delete(job.jobId);
    await post('/ext/error', {
      jobId: job.jobId,
      message: `could not reach the de.aipass.net tab (${tab.url ?? tab.id}): ${err?.message ?? err}`,
    });
  }
}

function handleEvent(name, data) {
  if (name === 'job') handleJob(data);
  else if (name === 'abort') {
    const tabId = jobTabs.get(data.jobId);
    if (tabId != null) chrome.tabs.sendMessage(tabId, { type: 'abort', jobId: data.jobId }).catch(() => {});
    jobTabs.delete(data.jobId);
  }
}

async function connect() {
  if (controller) return;
  controller = new AbortController();
  const signal = controller.signal;
  const cycle = setTimeout(() => controller?.abort(), CYCLE_MS);

  try {
    const res = await fetch(`${await bridgeUrl()}/ext/events`, {
      headers: { accept: 'text/event-stream', authorization: `Bearer ${await bridgeToken()}` },
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`bridge responded ${res.status}`);

    connected = true;
    lastError = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });

      let cut;
      while ((cut = pending.search(/\r?\n\r?\n/)) !== -1) {
        const frame = pending.slice(0, cut);
        pending = pending.slice(cut + pending.slice(cut).match(/^\r?\n\r?\n/)[0].length);

        let name = 'message';
        const dataLines = [];
        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith('event:')) name = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (!dataLines.length) continue; // comment / keepalive
        try { handleEvent(name, JSON.parse(dataLines.join('\n'))); } catch { /* ignore */ }
      }
    }
  } catch (err) {
    if (err?.name !== 'AbortError') lastError = String(err?.message ?? err);
  } finally {
    clearTimeout(cycle);
    connected = false;
    controller = null;
    setTimeout(connect, RECONNECT_MS);
  }
}

function handlePageMessage(msg) {
  if (msg?.type !== 'from-page') return false;
  const p = msg.payload;
  if (p.kind === 'chunk') post('/ext/chunk', { jobId: p.jobId, parts: p.parts });
  else if (p.kind === 'done') { jobTabs.delete(p.jobId); post('/ext/done', { jobId: p.jobId, finishReason: p.finishReason }); }
  else if (p.kind === 'error') { jobTabs.delete(p.jobId); post('/ext/error', { jobId: p.jobId, message: p.message }); }
  else if (p.kind === 'loader') { jobTabs.delete(p.jobId); post('/ext/loader', { jobId: p.jobId, raw: p.raw, message: p.message }); }
  return true;
}

// A content script holds this port open so Chrome does not evict the worker.
// Use that same port for page results: one-way runtime.sendMessage can resolve
// without a receiver after worker eviction, silently losing terminal replies.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'keepalive') return;
  connect(); // a de.aipass.net tab just appeared (or the worker just woke)
  port.onMessage.addListener(handlePageMessage);
  port.onDisconnect.addListener(() => { void chrome.runtime.lastError; });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (handlePageMessage(msg)) return;
  if (msg?.type === 'status') {
    (async () => {
      const tab = await findChatTab();
      sendResponse({
        connected,
        lastError,
        bridgeUrl: await bridgeUrl(),
        tab: tab ? { id: tab.id, url: tab.url } : null,
        activeJobs: jobTabs.size,
      });
    })();
    return true;
  }
  if (msg?.type === 'reconnect') { controller?.abort(); connect(); sendResponse({ ok: true }); return true; }
});

// The worker can be evicted at any time; the alarm brings it back and the
// connect() guard makes a duplicate call harmless.
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());

// Node tests opt out of the long-lived SSE connection and exercise these two
// boundary helpers directly.
if (globalThis.__AIPASS_BRIDGE_TEST__) {
  globalThis.__aipassBridgeTest = {
    post,
    ensureContentScript,
    handleJob,
    status: () => ({ lastError }),
  };
} else {
  connect();
}
