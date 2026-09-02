// Per-instance bearer token.
//
// Precedence: AIPASS_TOKEN env → ~/.aipass-bridge/token (0600, created if
// absent). Token never logged; boot prints the file path only.
//
// checkAuth(req) → true | 'missing' | 'invalid'. Constant-time compare.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const TOKEN_FILE = path.join(
  os.homedir(), '.aipass-bridge', 'token',
);

let cached = null;

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

// 'Bearer <token>' → 'missing' | 'invalid' | true
export function checkAuth(req) {
  const token = loadToken();
  const header = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/.exec(header);
  if (!m) return 'missing';
  return safeEqual(m[1].trim(), token) ? true : 'invalid';
}
