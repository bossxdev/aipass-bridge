// ISOLATED world. Two jobs: relay between page.js and the service worker, and
// keep that worker alive.
(() => {
const GEN = (window.__aipassBridgeContentGen ?? 0) + 1;
window.__aipassBridgeContentGen = GEN;
const current = () => window.__aipassBridgeContentGen === GEN;

const TAG = '__aipass_bridge';
let pageReady = false;
let workerPort = null;
let kaGen = 0;

// Sending to an evicted worker both wakes it and can transiently fail, so
// retry rather than dropping deltas on the floor. The upstream fetch keeps
// running in the page throughout.
async function toWorker(payload, attempt = 0) {
  try {
    if (!workerPort) throw new Error('worker port unavailable');
    workerPort.postMessage({ type: 'from-page', payload });
  } catch {
    if (attempt >= 5) {
      // Port never came back (e.g. extension reloaded under us): deliver
      // one-way rather than dropping the result.
      try { chrome.runtime.sendMessage({ type: 'from-page', payload }); } catch { /* gone */ }
      return;
    }
    setTimeout(() => toWorker(payload, attempt + 1), 200 * (attempt + 1));
  }
}

window.addEventListener('message', (event) => {
  if (!current()) return;
  if (event.source !== window) return;
  const msg = event.data;
  if (!msg || typeof msg !== 'object' || msg[TAG] !== 'res') return;
  const { [TAG]: _, ...payload } = msg;
  if (payload.kind === 'page-ready') pageReady = true;
  toWorker(payload);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!current()) return;
  if (msg?.type === 'run') window.postMessage({ [TAG]: 'req', job: msg.job }, window.location.origin);
  else if (msg?.type === 'abort') window.postMessage({ [TAG]: 'abort', jobId: msg.jobId }, window.location.origin);
  else if (msg?.type === 'ping') {
    window.postMessage({ [TAG]: 'ping' }, window.location.origin);
    sendResponse({ ok: pageReady });
    return true;
  }
});

// Chrome evicts an idle MV3 worker after ~30s, and inbound SSE data does not
// count as activity — without this the bridge sees a disconnect/reconnect
// cycle every half minute, and any job landing in that window fails. An open
// port does count, so hold one and cycle it before Chrome's 5-minute ceiling.
function keepAlive() {
  const gen = ++kaGen;
  let port;
  try {
    port = chrome.runtime.connect({ name: 'keepalive' });
    workerPort = port;
  }
  catch { setTimeout(() => { if (gen === kaGen) keepAlive(); }, 1000); return; }

  const beat = setInterval(() => {
    try { port.postMessage({ t: Date.now() }); } catch { /* disconnect handles it */ }
  }, 20_000);
  // Own-side disconnect does not fire own onDisconnect — reschedule here or
  // the port goes permanently dead and every page result is dropped.
  const cycle = setTimeout(() => {
    clearInterval(beat);
    try { port.disconnect(); } catch { /* already gone */ }
    if (gen === kaGen) keepAlive();
  }, 4 * 60 * 1000);

  port.onDisconnect.addListener(() => {
    if (gen !== kaGen) return;
    clearInterval(beat);
    clearTimeout(cycle);
    setTimeout(() => { if (gen === kaGen) keepAlive(); }, 250);
  });
}
keepAlive();
})();
