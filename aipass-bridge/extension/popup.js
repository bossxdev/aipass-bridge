const $ = (id) => document.getElementById(id);
let bridge = 'http://127.0.0.1:8787';
let token = '';
let lastModelSignature = '';
let savedAt = 0; // timestamp of last Save click — suppress poll overwrites briefly
const auth = () => ({ authorization: `Bearer ${token}` });

async function bridgeStatus(refresh = false) {
  try {
    const res = await fetch(`${bridge}/status`, { cache: 'no-store', headers: auth() });
    if (!res.ok) return null;
    const s = await res.json();
    if (refresh) await fetch(`${bridge}/v1/models?refresh=1`, { cache: 'no-store', headers: auth() });
    return s;
  } catch {
    return null;
  }
}

function renderModels(models, selected) {
  // Rebuilding on every poll would fight the user mid-selection.
  const signature = `${models.map((m) => `${m.id}${m.free}`).join('|')}::${selected}`;
  if (signature === lastModelSignature) return;
  lastModelSignature = signature;

  const sel = $('model');
  sel.innerHTML = '';
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    const tags = [m.free ? 'free' : null, m.thinking ? 'thinking' : null].filter(Boolean);
    opt.textContent = `${m.name || m.id}${m.provider ? ` — ${m.provider}` : ''}${tags.length ? `  [${tags.join(', ')}]` : ''}`;
    opt.selected = m.id === selected;
    sel.append(opt);
  }
  if (!models.some((m) => m.id === selected)) {
    const opt = document.createElement('option');
    opt.value = selected;
    opt.textContent = selected;
    opt.selected = true;
    sel.prepend(opt);
  }
  $('count').textContent = models.length ? `(${models.length})` : '';
}

async function refresh(forceModels = false) {
  const sw = await chrome.runtime.sendMessage({ type: 'status' });
  bridge = sw.bridgeUrl;
  token = (await chrome.storage.local.get('token')).token || '';
  if (document.activeElement !== $('token')) $('token').value = token;
  $('conn').innerHTML =
    `<span class="dot ${sw.connected ? 'up' : 'down'}"></span>${sw.connected ? 'connected' : 'not connected'}`;
  $('tab').textContent = sw.tab ? new URL(sw.tab.url).pathname : 'none open';
  $('jobs').textContent = String(sw.activeJobs);
  if (document.activeElement !== $('url') && Date.now() - savedAt > 2000) $('url').value = sw.bridgeUrl;

  const status = await bridgeStatus(forceModels);
  if (status) renderModels(status.models ?? [], status.defaultModel);

  $('err').textContent = sw.lastError || (status ? '' : 'bridge not reachable — is server.mjs running?');
}

$('model').addEventListener('change', async () => {
  await fetch(`${bridge}/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth() },
    body: JSON.stringify({ defaultModel: $('model').value }),
  }).catch(() => {});
});

$('save').addEventListener('click', async () => {
  const tokenVal = $('token').value.trim();
  if (tokenVal && !/^[\x20-\x7E]*$/.test(tokenVal)) {
    $('err').textContent = 'Bearer token must contain only printable ASCII characters.';
    return;
  }
  savedAt = Date.now();
  await chrome.storage.local.set({
    bridgeUrl: $('url').value.trim().replace(/\/+$/, ''),
    token: tokenVal,
  });
  await chrome.runtime.sendMessage({ type: 'reconnect' });
  setTimeout(() => refresh(true), 400);
});

$('refresh').addEventListener('click', () => refresh(true));

refresh(true);
setInterval(() => refresh(false), 1500);
