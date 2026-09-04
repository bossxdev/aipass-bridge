// Per-instance bearer token.
//
// Precedence: AIPASS_TOKEN env → ~/.aipass-bridge/token (0600, created if
// absent). Token never logged; boot prints the file path only.
//
// checkAuth(req) → 'missing' | 'invalid' | the authenticated key string.
// Constant-time compare. Minted keys and their conversation IDs persist in one
// atomic JSON file (0600). Legacy one-key-per-line files migrate on next write.
// mintKey() is called by the server only for main-token callers.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_FILE = path.join(
  os.homedir(), '.aipass-bridge', 'token',
);
const KEYS_FILE = process.env.AIPASS_KEYS_FILE || path.join(
  os.homedir(), '.aipass-bridge', 'keys',
);

let cached = null;
// Map<key, conversationId|null>. Loaded from the keys file at first use.
// ponytail: no revocation endpoint — remove the key in the JSON file and restart.
// Tests point AIPASS_KEYS_FILE at a temp file so the host store is untouched.
let runtimeKeys = null;

function saveRuntimeKeys() {
  const dir = path.dirname(KEYS_FILE);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = KEYS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({
    version: 1,
    keys: Object.fromEntries([...runtimeKeys].map(([k, c]) => [k, { conversationId: c }])),
  }), { mode: 0o600 });
  fs.renameSync(tmp, KEYS_FILE);
}

function loadRuntimeKeys() {
  if (runtimeKeys) return runtimeKeys;
  runtimeKeys = new Map();
  let raw = '';
  try { raw = fs.readFileSync(KEYS_FILE, 'utf8'); } catch { /* absent = none yet */ }
  if (raw.trim().startsWith('{')) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(raw).keys ?? {})) {
        if (typeof k === 'string' && k) runtimeKeys.set(k, typeof v?.conversationId === 'string' && v.conversationId ? v.conversationId : null);
      }
      return runtimeKeys;
    } catch { return runtimeKeys; } // corrupt structured store fails closed
  }
  // Legacy: one key per line, no conversation.
  for (const line of raw.split('\n')) {
    const k = line.trim();
    if (k && !k.includes('{')) runtimeKeys.set(k, null);
  }
  return runtimeKeys;
}

export function loadToken() {
  if (cached) return cached;
  if (process.env.AIPASS_TOKEN) {
    cached = process.env.AIPASS_TOKEN;
    return cached;
  }
  try {
    cached = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (cached) return cached;
  } catch { /* fall through to generate */ }
  cached = randomBytes(32).toString('base64url');
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(TOKEN_FILE, cached + '\n', { mode: 0o600 });
  try { fs.chmodSync(TOKEN_FILE, 0o600); } catch { /* best-effort on odd FS */ }
  return cached;
}

export const tokenFilePath = () => TOKEN_FILE;
export const isMintedKey = (key) => loadRuntimeKeys().has(key);
export const conversationForKey = (key) => loadRuntimeKeys().get(key) ?? null;
export function setConversationForKey(key, conversationId) {
  const keys = loadRuntimeKeys();
  if (!keys.has(key)) return false;
  keys.set(key, conversationId || null);
  saveRuntimeKeys();
  return true;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    // Still do a compare to keep timing flat-ish; length leak is acceptable.
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

// 'Bearer <token>' → 'missing' | 'invalid' | the authenticated key string
export function checkAuth(req) {
  const token = loadToken();
  const header = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/.exec(header);
  if (!m) return 'missing';
  const presented = m[1].trim();
  if (safeEqual(presented, token)) return token;
  for (const k of loadRuntimeKeys().keys()) if (safeEqual(presented, k)) return k;
  return 'invalid';
}

// Mint a new bearer key. Caller authenticates first; the key is returned once
// and never logged. Persisted atomically so it survives restarts.
export function mintKey() {
  const key = 'ab_' + randomBytes(24).toString('hex');
  const keys = loadRuntimeKeys();
  keys.set(key, null);
  saveRuntimeKeys();
  return key;
}
