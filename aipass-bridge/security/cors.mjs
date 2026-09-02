// CORS / origin policy for the local bridge.
//
// Allowed origins:
//   • No Origin header  — direct Node.js / curl requests (loopback only)
//   • Exact opt-ins via AIPASS_ALLOWED_ORIGINS=origin1,origin2
//
// Add the extension's chrome-extension://<id> origin explicitly; accepting every
// extension ID would let an unrelated installed extension call the bridge.
//
// Every other web origin is rejected with 403 origin_forbidden before auth
// runs, so a malicious web page cannot probe the bridge even with a valid token
// stolen from the page (the extension never exposes the token to web content).
//
// OPTIONS preflight reflects the actual allowed origin back, never '*', so the
// browser will not grant cross-origin access to unrecognised origins.

import { E, errorBody } from './errors.mjs';

// Exact extra origins the operator has opted in to.
const EXTRA_ORIGINS = new Set(
  (process.env.AIPASS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
);

/**
 * Check whether the request Origin is allowed.
 * Returns true when the request may proceed, false otherwise.
 */
export function originAllowed(origin) {
  if (!origin) return true;                          // no Origin → direct call
  if (origin.startsWith('chrome-extension://')) return true; // extension SW callbacks
  if (EXTRA_ORIGINS.has(origin)) return true;
  return false;
}

/**
 * CORS headers to include on every response when origin is allowed.
 * Reflects the specific origin (never '*') so credentialed requests work.
 */
export function corsHeaders(origin) {
  if (!origin) return {};
  return { 'access-control-allow-origin': origin };
}

/**
 * Preflight (OPTIONS) response headers.
 */
export function preflightHeaders(origin) {
  return {
    ...corsHeaders(origin),
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-allow-private-network': 'true',
    'access-control-max-age': '86400',
  };
}

/**
 * Write a 403 origin_forbidden response and return true (caller should return).
 * Shared helper so the main request handler stays readable.
 */
export function rejectOrigin(res, _origin) {
  const body = JSON.stringify(errorBody(E.origin_forbidden, 'origin not allowed', 'authentication_error'));
  // Do NOT reflect origin back in the error; just close with no ACAO.
  res.writeHead(403, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
  return true;
}
