#!/usr/bin/env node
// Talk to aipass from the terminal. Streams the reply, shows server-side tool
// activity (web_search) as it happens, and lists sources at the end.
//
//   npm run chat                 interactive
//   npm run chat -- "question"   one-shot
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const BRIDGE = (flag('bridge', 'http://127.0.0.1:8787')).replace(/\/+$/, '');
const { loadToken } = await import(new URL('./security/auth.mjs', import.meta.url));
const AUTH = { authorization: `Bearer ${loadToken()}` };
const CONVERSATION = flag('conversation', null);
const NEW = argv.includes('--new');
let model = flag('model', null);
const question = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--')).join(' ').trim();

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

const status = await fetch(`${BRIDGE}/status`, { headers: AUTH }).then((r) => r.json()).catch(() => null);
if (!status) {
  console.error(red(`No bridge at ${BRIDGE}. Start it with: npm run dev`));
  process.exit(1);
}
if (!status.extensions) {
  console.error(red('The extension is not connected. Open a https://de.aipass.net/chat tab.'));
  process.exit(1);
}
model ??= status.defaultModel;

if (CONVERSATION) {
  await fetch(`${BRIDGE}/config`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...AUTH },
    body: JSON.stringify({ conversation: CONVERSATION }),
  }).catch(() => {});
} else if (NEW) {
  const made = await fetch(`${BRIDGE}/conversations/new`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...AUTH },
    body: JSON.stringify({ model, message: 'New chat.' }),
  }).then((r) => r.json()).catch(() => null);
  if (made?.id) status.conversation = made.id;
}

async function ask(text) {
  const res = await fetch(`${BRIDGE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH },
    body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: text }] }),
  });
  if (!res.ok) {
    console.error(red(`\nbridge returned ${res.status}: ${(await res.text()).slice(0, 300)}`));
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let wrote = false;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, cut); buf = buf.slice(cut + 2);
      const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (!data || data === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(data); } catch { continue; }
      if (evt.error) { console.error(red(`\n${evt.error.message}`)); return; }
      const delta = evt.choices?.[0]?.delta ?? {};
      // Tool progress and sources, kept visually distinct from the answer.
      if (delta.reasoning_content) stdout.write(cyan(delta.reasoning_content));
      if (delta.content) { stdout.write(delta.content); wrote = true; }
    }
  }
  stdout.write(wrote ? '\n' : dim('\n(no reply)\n'));
}

if (question) {
  await ask(question);
  process.exit(0);
}

console.log(bold('aipass') + dim(`  model ${model}  ·  conversation ${status.conversation ?? 'resolves on first message'}`));
console.log(dim('/model <id> to switch  ·  /models to list  ·  Ctrl+C to quit\n'));

const rl = readline.createInterface({ input: stdin, output: stdout });
for (;;) {
  let line;
  try { line = (await rl.question(bold('> '))).trim(); }
  catch { break; } // Ctrl+C / Ctrl+D
  if (!line) continue;

  if (line === '/models') {
    const { data } = await fetch(`${BRIDGE}/v1/models`, { headers: AUTH }).then((r) => r.json());
    for (const m of data) console.log(`  ${m.id.padEnd(38)} ${m.name}${m.free_credit ? dim('  [free]') : ''}`);
    continue;
  }
  if (line.startsWith('/model ')) {
    model = line.slice(7).trim();
    await fetch(`${BRIDGE}/config`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...AUTH },
      body: JSON.stringify({ defaultModel: model }),
    }).catch(() => {});
    console.log(dim(`  model ${model}`));
    continue;
  }

  await ask(line);
  console.log();
}
rl.close();
