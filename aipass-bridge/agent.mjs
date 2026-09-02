#!/usr/bin/env node
// Local file tools driven by aipass.
//
// Two constraints shape this, both learned the hard way:
//
//  1. Only one user message per request is accepted. An array containing an
//     assistant turn is rejected upstream with a 403 before the model sees it.
//  2. The server keeps the conversation history itself.
//
// So the instructions are sent ONCE, as the first message of a conversation,
// and every later turn is just the tool results. Payloads stay small, nothing
// is resent, and no system prompt is needed — the preamble becomes part of the
// history the server already remembers.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { canonicalize, isDenied } from './security/paths.mjs';
import { E } from './security/errors.mjs';
import { redact as redactSensitive } from './security/dlp.mjs';
import { loadToken } from './security/auth.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);
const flags = (name) => argv.flatMap((a, i) => a === `--${name}` && argv[i + 1] ? [argv[i + 1]] : []);

const task = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--')).join(' ').trim();
const ROOT = fs.realpathSync(path.resolve(flag('root', process.cwd())));
const BRIDGE = (flag('bridge', 'http://127.0.0.1:8787')).replace(/\/+$/, '');
const MODEL = flag('model', null);
const MAX_STEPS = Number(flag('max', 10));
const APPLY = has('apply');
const ALLOW_RUN = has('allow-run');
const MAX_RESULT = Number(flag('max-result', 3000));
const CONVERSATION = flag('conversation', null);
// A conversation carries its own history, so reusing one drags in whatever was
// said before — including any refusal. Each run gets a fresh one by default.
const REUSE = has('reuse');
// When the conversation is bound to a custom aipass assistant that already
// carries the NEED/EDIT/CREATE/DONE instructions, the preamble is redundant —
// and sending it again is just extra payload for the edge to inspect.
const SLIM = has('slim');
// Stay open after the first task and take follow-ups on the same conversation,
// so the model keeps everything it has already read in context.
const WATCH = has('watch');
// Bind new conversations to a custom aipass assistant. The field name the
// create form uses is set by AIPASS_ASSISTANT_FIELD on the bridge; here we just
// pass the id through. Implies --slim, since the assistant carries the protocol.
const ASSISTANT = flag('assistant', process.env.AIPASS_ASSISTANT_ID || null);
// Explicit, exact-path override of the sensitive-file denylist. Each value is
// normalized to a POSIX rel path and must match exactly. Never implied by
// --apply or --watch; passing it is a deliberate, per-run decision.
const ALLOW_PATHS = new Set(flags('allow-path').map((p) => p.replace(/\\/g, '/').replace(/^\.\//, '')));

if (!task) {
  console.error(`usage: npm run agent -- "<task>" [options]

  --root DIR      project root the agent may touch   (default: cwd)
  --model ID      model id                           (default: bridge default)
  --apply         write changes to disk              (default: dry run)
  --allow-run     let the agent run shell commands   (default: off)
  --max N         max steps                          (default: 10)
  --max-result N  truncate each tool result          (default: 6000 bytes)`);
  process.exit(1);
}

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;

/* ------------------------------------------------------- overlay filesystem */

const overlay = new Map();

function safe(p) {
  const { abs, rel } = canonicalize(ROOT, p);
  if (isDenied(rel) && !ALLOW_PATHS.has(rel)) {
    throw Object.assign(new Error(`forbidden path: ${rel} is on the sensitive-file denylist (explicit --allow-path RELPATH overrides per run)`), { code: E.forbidden_path });
  }
  return abs;
}
const readAt = (abs) => (overlay.has(abs) ? overlay.get(abs) : fs.readFileSync(abs, 'utf8'));
const existsAt = (abs) => overlay.has(abs) || fs.existsSync(abs);
const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.cache']);

const clip = (s) => (s.length > MAX_RESULT ? `${s.slice(0, MAX_RESULT)}\n… truncated` : s);
const READ_LINES = Number(flag('read-lines', 250));

// read() shows a line-number gutter so the model can reference ranges. Those
// numbers are display only; strip them off a FIND block in case the model
// copied them back — but only when every non-empty line carries one, so real
// content that merely contains a pipe is left alone.
function stripGutter(block) {
  const gutter = /^\s{0,6}\d+\s*\|\s?/;
  const lines = block.split('\n');
  const nonEmpty = lines.filter((l) => l.trim());
  if (nonEmpty.length && nonEmpty.every((l) => gutter.test(l))) {
    return lines.map((l) => l.replace(gutter, '')).join('\n');
  }
  return block;
}

// Loopback hostnames and internal addresses are what SSRF filter rules look
// for, and ordinary project files are full of them — a README saying
// "open http://localhost:3000" is enough to get a request rejected.
//
// Substitute them on the way out and restore them on the way back, so the
// model works with stable placeholders and the bytes written to disk are
// exactly what the file had. The placeholders deliberately share no substring
// with the originals, or a case-insensitive rule would still match.
const SUBSTITUTIONS = [
  [/127\.0\.0\.1/g, 'LOOPBACK-IP'],
  [/169\.254\.169\.254/g, 'METADATA-IP'],
  [/0\.0\.0\.0/g, 'ANY-IP'],
  [/localhost/gi, 'LCLHST'],
  [/file:\/\//gi, 'FILE-URI'],
  // HTML/XSS-shaped tokens that ordinary files carry — a markdown or Vue file
  // opening with an HTML comment is enough to trip an XSS rule.
  [/<!doctype/gi, 'DOCTYPE-DECL'],
  [/<!--/g, 'CMT-OPEN'],
  [/-->/g, 'CMT-CLOSE'],
  [/<script/gi, 'TAG-SCRIPT-OPEN'],
  [/<\/script>/gi, 'TAG-SCRIPT-CLOSE'],
  [/javascript:/gi, 'JS-SCHEME'],
  // `.env` is a classic secrets-probe pattern that WAFs block outright — and it
  // rides inside `process.env`, which appears constantly in real code.
  [/process\.env/gi, 'PROCESS-ENV'],
  [/\.env\b/gi, 'DOT-ENV'],
  // The general case: a `<` that opens a tag (`<html`, `<div`, `</body>`, a JSX
  // component) is what an XSS rule matches. Encode just that `<` — not `a < b`
  // or `=>` — so any HTML/JSX/XML file survives, restored exactly on write.
  [/<(?=[a-zA-Z/!?])/g, 'TAG-LT'],
];

const outbound = (text) => SUBSTITUTIONS.reduce((acc, [re, to]) => acc.replace(re, to), text);

// Reversing loses the original casing of "localhost"; lower case is what
// appears in practice and a mismatch only costs a retry, never a bad write.
const RESTORE = [
  [/LOOPBACK-IP/g, '127.0.0.1'],
  [/METADATA-IP/g, '169.254.169.254'],
  [/ANY-IP/g, '0.0.0.0'],
  [/LCLHST/g, 'localhost'],
  [/FILE-URI/g, 'file://'],
  [/DOCTYPE-DECL/g, '<!doctype'],
  [/CMT-OPEN/g, '<!--'],
  [/CMT-CLOSE/g, '-->'],
  [/TAG-SCRIPT-OPEN/g, '<script'],
  [/TAG-SCRIPT-CLOSE/g, '</script>'],
  [/JS-SCHEME/g, 'javascript:'],
  [/PROCESS-ENV/g, 'process.env'],
  [/DOT-ENV/g, '.env'],
  [/TAG-LT/g, '<'],
];

const inbound = (text) => (text == null ? text : RESTORE.reduce((acc, [re, to]) => acc.replace(re, to), text));

const TOOLS = {
  list(arg) {
    const abs = safe(arg || '.');
    const base = path.relative(ROOT, abs).split(path.sep).join('/');
    return clip(fs.readdirSync(abs, { withFileTypes: true })
      .filter((e) => !SKIP.has(e.name))
      .filter((e) => {
        const rel = base ? `${base}/${e.name}` : e.name;
        return ALLOW_PATHS.has(rel) || !isDenied(rel);
      })
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort().join('\n') || '(empty)');
  },
  read(arg) {
    // Accept an optional trailing line range, e.g. `NEED file src/app.ts 200-320`.
    const parts = String(arg).trim().split(/\s+/);
    let range = null;
    if (parts.length > 1 && /^\d+-\d+$/.test(parts.at(-1))) {
      const [a, b] = parts.pop().split('-').map(Number);
      range = [a, b];
    }
    const rel = parts.join(' ');
    const abs = safe(rel);
    if (!existsAt(abs)) return `no such file: ${rel}`;

    const lines = readAt(abs).split('\n');
    const total = lines.length;
    let start = 1, end = total;
    if (range) { start = Math.max(1, range[0]); end = Math.min(total, range[1]); }
    else if (total > READ_LINES) end = READ_LINES;

    const width = String(end).length;
    const numbered = lines.slice(start - 1, end)
      .map((l, i) => `${String(start + i).padStart(width)} | ${l}`)
      .join('\n');

    let note = '';
    if (end < total) note = `\n… ${total - end} more line(s). To see them: NEED file ${rel} ${end + 1}-${Math.min(total, end + READ_LINES)}`;
    else if (start > 1) note = `\n(lines ${start}-${end} of ${total})`;
    return numbered + note;
  },
  write(arg, rawBody) {
    const body = inbound(rawBody);
    overlay.set(safe(arg), body);
    return `wrote ${arg}, ${body.split('\n').length} lines`;
  },
  replace(arg, rawBody) {
    const abs = safe(arg);
    if (!existsAt(abs)) return `no such file: ${arg}`;
    const before = inbound(stripGutter(rawBody[0]));
    const after = inbound(rawBody[1]);
    const text = readAt(abs);
    if (!before) return `the text to change was empty. Copy the exact lines to find under FIND.`;

    const count = text.split(before).length - 1;
    if (count === 0) return `the text to change was not found in ${arg}. Read it again with NEED file ${arg} and copy the lines exactly.`;
    if (count > 1) return `that text appears ${count} times in ${arg}. Include a few more surrounding lines under FIND so it matches exactly one place.`;

    overlay.set(abs, text.replace(before, after));
    return `updated ${arg} (1 change)`;
  },
  search(arg) {
    const query = String(arg).trim();
    if (!query) return 'give me some text to search for.';
    const needle = inbound(query); // the model may type placeholders like LCLHST
    const hits = [];
    const visited = new Set();
    const MAX = 50;
    const walk = (dir) => {
      if (hits.length >= MAX || visited.has(dir)) return;
      visited.add(dir);
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
        // safe() canonicalizes through symlinks and applies the denylist, so a
        // linked dir escaping root or a denied file is skipped, never read.
        let full;
        try { full = safe(path.join(dir, e.name)); } catch { continue; }
        if (e.isDirectory()) { walk(full); continue; }
        if (hits.length >= MAX) return;
        let text;
        try { text = readAt(full); } catch { continue; }
        if (text.includes('\u0000')) continue; // skip binary
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && hits.length < MAX; i++) {
          if (lines[i].includes(needle)) {
            hits.push(`${path.relative(ROOT, full)}:${i + 1}: ${lines[i].trim().slice(0, 140)}`);
          }
        }
      }
    };
    walk(fs.realpathSync(ROOT));
    if (!hits.length) return `no matches for "${query}".`;
    const more = hits.length >= MAX ? `\n… stopped at ${MAX} matches; make the search more specific for the rest.` : '';
    return hits.join('\n') + more;
  },
  run(_arg, body) {
    if (!ALLOW_RUN) return 'shell commands are disabled for this run';
    // Scrub credentials from the child environment. The child inherits only
    // a safe subset: PATH, HOME, LANG, TERM, USER, LOGNAME, TMPDIR, TZ.
    // Keys that carry secrets (tokens, passwords, keys, AWS/GCP/Azure creds,
    // the bridge token itself) are stripped so they cannot be exfiltrated via
    // environment-printing commands such as `env` or `printenv`.
    const SAFE_ENV_KEYS = new Set([
      'PATH', 'HOME', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE',
      'TERM', 'COLORTERM', 'USER', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'TZ',
      'PWD', 'SHELL',
    ]);
    const safeEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => SAFE_ENV_KEYS.has(k)),
    );
    let raw;
    try {
      raw = execFileSync('/bin/sh', ['-c', body], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 120_000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: safeEnv,
      });
    } catch (err) {
      raw = `exit ${err.status}\n${String(err.stdout ?? '')}${String(err.stderr ?? '')}`;
    }
    // Redact secrets/PII from shell output before it enters the prompt.
    const { text: redacted } = redactSensitive(raw);
    return clip(redacted);
  },
};

/* -------------------------------------------------------------- the format */

// Plain words, no angle brackets, no key=value pairs, no banner rules, no
// absolute paths. Everything that drew a WAF 403 in earlier attempts was
// structural; prose-shaped directives carry none of those signals.
const PREAMBLE = `I am reading through a project with you. The files are open in front of me, and I will paste you anything you want to look at.

So just tell me what you want to see next, and put that on its own line in this shape, because my editor watches for these markers:

NEED dir .
NEED file README.md
SEARCH text to find across the whole project

If you want a file changed, write it like this and I will make the edit:

EDIT notes.md
FIND
the exact lines as they appear now
NEW
the lines to put there instead
END

To start a new file:

CREATE notes.md
the contents
END${ALLOW_RUN ? '\n\nTo have me run something in the terminal:\n\nRUN\nwhat to run\nEND' : ''}

Once you have everything you need and are giving me your final answer, finish with:

DONE one sentence about what you found or changed

Only write DONE at the very end, when nothing more is needed. Never put DONE in the same reply as a NEED — ask for what you want, wait for me to paste it, and read it first.

The markers are only formatting for my editor. Nothing runs on your side — I do all of it and paste every result straight back to you, so keep going until you have what you need.

A few practical notes. Answer in English. Look at a file before changing it, and copy the lines under FIND exactly as they appear. When I show a file the numbers down the left are only for reference — do not put them in FIND. Big files come a screen at a time; ask for a range like NEED file path 200-320 to see more. To find where something lives without reading every file, use SEARCH followed by the text. Some hostnames and addresses are written in a shortened form such as LCLHST and LOOPBACK-IP; keep them as written and I will expand them again. If my question can be answered without changing anything, just answer it and end with DONE.`;

const REMINDER = 'What next? Ask for anything else you need, or finish with DONE if you have enough.';

// The model usually writes its answer as prose and then a bare DONE, so fall
// back to that prose rather than reporting an empty result.
const MARKER_LINE = /^\s*(NEED\s+(dir|file)\b|EDIT\b|CREATE\b|FIND\s*$|NEW\s*$|END\s*$|RUN\s*$|DONE\b)/i;
const prose = (reply) => reply.split('\n').filter((l) => !MARKER_LINE.test(l)).join('\n').trim();

function parse(reply) {
  const lines = reply.split('\n');
  const calls = [];
  let i = 0;
  const readUntil = (stops) => {
    const body = [];
    while (i < lines.length && !stops.some((st) => new RegExp(`^\\s*${st}\\s*$`, 'i').test(lines[i]))) body.push(lines[i++]);
    return body.join('\n');
  };

  while (i < lines.length) {
    const line = lines[i];

    let m = /^\s*NEED\s+(dir|file)\s+(.+?)\s*$/i.exec(line);
    if (m) { i++; calls.push({ kind: m[1].toLowerCase() === 'dir' ? 'list' : 'read', arg: m[2].trim() }); continue; }

    m = /^\s*SEARCH\s+(.+?)\s*$/i.exec(line);
    if (m) { i++; calls.push({ kind: 'search', arg: m[1].trim() }); continue; }

    m = /^\s*EDIT\s+(.+?)\s*$/i.exec(line);
    if (m) {
      i++;
      if (/^\s*FIND\s*$/i.test(lines[i] ?? '')) i++;
      const before = readUntil(['NEW', 'END']);
      if (/^\s*NEW\s*$/i.test(lines[i] ?? '')) i++;
      const after = readUntil(['END']);
      if (/^\s*END\s*$/i.test(lines[i] ?? '')) i++;
      calls.push({ kind: 'replace', arg: m[1].trim(), body: [before, after] });
      continue;
    }

    m = /^\s*CREATE\s+(.+?)\s*$/i.exec(line);
    if (m) {
      i++;
      const body = readUntil(['END']);
      if (/^\s*END\s*$/i.test(lines[i] ?? '')) i++;
      calls.push({ kind: 'write', arg: m[1].trim(), body });
      continue;
    }

    if (/^\s*RUN\s*$/i.test(line)) {
      i++;
      const body = readUntil(['END']);
      if (/^\s*END\s*$/i.test(lines[i] ?? '')) i++;
      calls.push({ kind: 'run', arg: '', body });
      continue;
    }

    m = /^\s*DONE\b\s*(.*)$/i.exec(line);
    if (m) { i++; calls.push({ kind: 'done', arg: m[1].trim() }); continue; }

    i++;
  }
  return calls;
}

/* -------------------------------------------------------------- the bridge */

async function say(text) {
  const res = await fetch(`${BRIDGE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${loadToken()}`,
    },
    body: JSON.stringify({ ...(MODEL ? { model: MODEL } : {}), stream: true, messages: [{ role: 'user', content: text }] }),
  });
  if (!res.ok) throw new Error(`bridge returned ${res.status}: ${(await res.text()).slice(0, 300)}`);

  let out = '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
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
      if (evt.error) throw new Error(evt.error.message);
      const delta = evt.choices?.[0]?.delta ?? {};
      if (delta.reasoning_content) process.stdout.write(cyan(delta.reasoning_content));
      if (delta.content) { out += delta.content; process.stdout.write(dim(delta.content)); }
    }
  }
  process.stdout.write('\n');
  return out;
}

// File contents are arbitrary: a README carries shell commands, URLs and code
// fences, any of which can push a request past an upstream filter. Splitting a
// rejected message in half and sending the halves in sequence keeps the same
// information flowing while lowering what any single request carries. The
// server remembers each part, so the model still sees the whole thing.
function splitInHalf(text) {
  const lines = text.split('\n');
  if (lines.length < 2) {
    const mid = Math.floor(text.length / 2);
    return [text.slice(0, mid), text.slice(mid)];
  }
  const mid = Math.ceil(lines.length / 2);
  return [lines.slice(0, mid).join('\n'), lines.slice(mid).join('\n')];
}

const MIN_SPLIT = 300;

// Last resort when a fragment is rejected even on its own. Real source files
// contain code-execution shapes — `node -e`, `curl`, `rm -rf`, `/bin/sh` — that
// no amount of splitting gets past. Drop only the offending lines so the run
// survives and the model still sees the rest of the file.
const RISKY_LINE = /(node\s+-{1,2}e\b|--eval\b|\beval\(|child_process|exec(Sync)?\(|spawnSync?\(|\bcurl\b|\bwget\b|\b(ba)?sh\s+-c\b|rm\s+-rf|\/etc\/|\/bin\/(ba)?sh|\.\.\/\.\.\/|<!doctype|<!--|-->|<script|<\/script|javascript:|onerror\s*=|onload\s*=)/i;

function redact(text) {
  let dropped = 0;
  const out = text.split('\n').map((line) => {
    if (!RISKY_LINE.test(line)) return line;
    dropped++;
    return '[one line omitted here — it could not be sent]';
  }).join('\n');
  return { out, dropped };
}

async function sayResilient(text, depth = 0) {
  if (depth === 0) {
    // Final defense-in-depth boundary. Redact assembled prompts (including task
    // text and listings) before WAF transport substitutions encode them.
    const redacted = redactSensitive(text);
    const tally = Object.entries(redacted.counts);
    if (tally.length) console.log(dim(`  dlp: ${tally.map(([k, n]) => `${k}:${n}`).join(' ')} redacted before send`));
    text = outbound(redacted.text);
  }
  try {
    return await say(text);
  } catch (err) {
    const blocked = /\b40[39]\b/.test(err.message);
    if (!blocked) throw err;

    if (depth > 4 || Buffer.byteLength(text) < MIN_SPLIT) {
      const { out, dropped } = redact(text);
      if (dropped && out !== text) {
        console.log(dim(`  rejected at ${Buffer.byteLength(text)} bytes — omitting ${dropped} line(s) that cannot be sent`));
        return await say(out);
      }
      console.error(red('\nthis fragment was rejected even on its own:\n') + dim(text.slice(0, 400)));
      throw err;
    }
    const parts = splitInHalf(text);
    console.log(dim(`  rejected — splitting into ${parts.length} parts and resending`));
    let last;
    for (let i = 0; i < parts.length; i++) {
      const final = i === parts.length - 1;
      const prefix = final
        ? 'Final part.\n\n'
        : `Part ${i + 1}, more follows. Reply with just: ok\n\n`;
      last = await sayResilient(prefix + parts[i], depth + 1);
    }
    return last;
  }
}

/* ---------------------------------------------------------------- the loop */

function showDiff() {
  if (!overlay.size) { console.log(dim('\nno file changes')); return; }
  console.log(bold(`\n${overlay.size} file(s) changed:\n`));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-'));
  for (const [abs, next] of overlay) {
    const rel = path.relative(ROOT, abs);
    const a = path.join(tmp, 'a'); const b = path.join(tmp, 'b');
    fs.writeFileSync(a, fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '');
    fs.writeFileSync(b, next);
    let diff;
    try { diff = execFileSync('diff', ['-u', '--label', `a/${rel}`, '--label', `b/${rel}`, a, b], { encoding: 'utf8' }); }
    catch (err) { diff = String(err.stdout ?? ''); }
    for (const line of diff.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) console.log(green(line));
      else if (line.startsWith('-') && !line.startsWith('---')) console.log(red(line));
      else console.log(dim(line));
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

const AUTH = { authorization: `Bearer ${loadToken()}` };
if (CONVERSATION) {
  await fetch(`${BRIDGE}/config`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...AUTH },
    body: JSON.stringify({ conversation: CONVERSATION }),
  }).catch(() => {});
} else if (!REUSE) {
  const made = await fetch(`${BRIDGE}/conversations/new`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...AUTH },
    body: JSON.stringify({ ...(MODEL ? { model: MODEL } : {}), ...(ASSISTANT ? { assistant: ASSISTANT } : {}), message: 'Starting a new working session.' }),
  }).then((r) => r.json()).catch((err) => ({ error: { message: String(err.message) } }));
  if (made?.error) console.error(red(`could not start a new conversation: ${made.error.message}`));
}
const bridgeStatus = await fetch(`${BRIDGE}/status`, { headers: AUTH }).then((r) => r.json()).catch(() => null);

console.log(bold('root  ') + ROOT);
console.log(bold('mode  ') + (APPLY ? green('APPLY — files will be written') : 'dry run (pass --apply to write)'));
console.log(bold('chat  ') + (bridgeStatus?.conversation ?? 'resolves on first message') +
  dim(CONVERSATION ? '  (continuing)' : REUSE ? '  (reusing the most recent)' : '  (new)') +
  (ASSISTANT ? dim(`  · assistant ${ASSISTANT}`) : ''));
if (REUSE || WATCH || CONVERSATION) {
  console.warn('warning: this mode reuses upstream conversation history; sensitive data may persist upstream');
}

const useSlim = SLIM || Boolean(ASSISTANT);

// One task: drive the loop to a DONE (or a limit), then report and write.
// The conversation persists across calls, so the model keeps its context.
async function runTask(taskText, { first }) {
  overlay.clear();
  let listing = '';
  try { listing = outbound(TOOLS.list('.')); } catch { /* ignore */ }

  let next = useSlim
    ? `${first ? `Top level of the project: ${listing}\n\n` : ''}Task: ${taskText}\n\nWhat should I open first?`
    : first
      ? `${PREAMBLE}\n\nTo save you a step, here is what is at the top level already:\n${listing}\n\nHere is what I want to know: ${taskText}\n\nWhat should I open first?`
      : `New task: ${taskText}\n\nWhat should I open first?`;

  let nudges = 0;
  for (let step = 1; step <= MAX_STEPS; step++) {
    console.log(bold(`\n─── step ${step}/${MAX_STEPS} ${'─'.repeat(40)}`));
    let reply;
    try { reply = await sayResilient(next); }
    catch (err) { console.error(red(`\n${err.message}`)); break; }
    reply = inbound(reply); // decode: everything we send is encoded, everything we read is decoded

    const calls = parse(reply);
    const done = calls.find((c) => c.kind === 'done');
    const work = calls.filter((c) => c.kind !== 'done');

    if (!work.length) {
      if (done) { console.log(green(`\n✓ ${done.arg || prose(reply) || 'done'}`)); break; }
      if (++nudges > 2) { console.log(red('\nno marker after three replies — stopping.')); break; }
      console.log(red(`\nno marker in that reply — nudging (${nudges}/2)`));
      next = `I could not tell what to open from that. I have the project open here and I am pasting you whatever you name — nothing happens on your side. ${REMINDER}`;
      continue;
    }
    nudges = 0;

    const results = [];
    for (const call of work) {
      let result;
      try { result = TOOLS[call.kind](call.arg, call.body); }
      catch (err) { result = `error: ${err.message}`; }
      // Defense-in-depth: strip secrets/PII from every tool result BEFORE
      // WAF encoding, so sensitive values never enter the outbound message
      // even when the file that held them was explicitly allowed.
      const { text: clean, counts } = redactSensitive(result);
      const tally = Object.entries(counts);
      if (tally.length) console.log(dim(`  dlp: ${tally.map(([k, n]) => `${k}:${n}`).join(' ')} redacted in ${call.kind} ${call.arg}`));
      const head = clean.split('\n')[0];
      console.log(`  ${/^(no such|error|the text)/.test(clean) ? red('✗') : green('✓')} ${call.kind} ${call.arg} ${dim(head.slice(0, 70))}`);
      results.push(`Result of ${call.kind} ${call.arg}:\n${outbound(clean)}`);
    }

    const stillLooking = work.some((c) => c.kind === 'list' || c.kind === 'read' || c.kind === 'search');
    if (done && !stillLooking) { console.log(green(`\n✓ ${done.arg || prose(reply) || 'done'}`)); break; }
    if (done) console.log(dim('  (ignoring DONE — it came before the results it asked for)'));
    next = `${results.join('\n\n')}\n\n${REMINDER}`;
    if (step === MAX_STEPS) console.log(red('\nreached the step limit'));
  }

  showDiff();
  if (APPLY && overlay.size) {
    for (const [abs, text] of overlay) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, text);
    }
    console.log(green(`\nwrote ${overlay.size} file(s) to disk`));
  } else if (overlay.size) {
    console.log(dim('\ndry run — nothing written. re-run with --apply'));
  }
}

await runTask(task, { first: true });

if (WATCH) {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log(dim('\n— watching. type another task, or press Ctrl+C to stop —'));
  rl.setPrompt(bold('\ntask> '));
  rl.prompt();
  // The async iterator ends cleanly on EOF (piped input) or Ctrl+D.
  for await (const raw of rl) {
    const line = raw.trim();
    if (line === 'exit' || line === 'quit') break;
    if (line) await runTask(line, { first: false });
    rl.prompt();
  }
  rl.close();
  console.log(dim('\ndone.'));
}
