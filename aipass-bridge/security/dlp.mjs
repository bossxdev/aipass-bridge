// DLP (Data Loss Prevention) redaction.
//
// Runs BEFORE WAF encoding (outbound) and before any text reaches the upstream.
// Pattern-based: novel formats may pass through. See README residual-risks.
//
// redact(text) → { text: string, counts: Record<string,number> }
// Never throws. Returns the input unchanged on any internal error.

const REDACTED = '[REDACTED]';

// Each entry: [name, regex, replacer?]
// When replacer is omitted the entire match is replaced.
// When provided, replacer receives the match and returns the substitution.
const RULES = [
  // ── Private / RSA / EC keys ─────────────────────────────────────────
  [
    'private_key',
    /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]+?-----END[A-Z ]*PRIVATE KEY-----/g,
  ],

  // ── AWS credentials ──────────────────────────────────────────────────
  ['aws_access_key', /\bAKIA[0-9A-Z]{16}\b/g],
  [
    'aws_secret_key',
    /(aws_secret_access_key\s*[:=]\s*)([^\s"'&]+)/gi,
    (m, prefix) => `${prefix}${REDACTED}`,
  ],

  // ── Provider API tokens ──────────────────────────────────────────────
  ['anthropic_key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ['openai_key',  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
  ['github_token', /\b(ghp_|gho_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{20,}\b/g],
  ['slack_token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ['google_key',  /\bAIza[A-Za-z0-9_-]{30,}\b/g],

  // ── Bearer / Authorization headers ───────────────────────────────────
  [
    'bearer_token',
    /((?:authorization\s*[:=]\s*)?bearer\s+)([A-Za-z0-9+/._~-]{16,}={0,2})/gi,
    (m, prefix) => `${prefix}${REDACTED}`,
  ],

  // ── JWTs (eyJ…) ──────────────────────────────────────────────────────
  ['jwt', /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g],

  // ── Connection strings with inline credentials ───────────────────────
  [
    'connection_string',
    /([a-z][a-z0-9+.-]*:\/\/)([^@\s"']{3,}@)/gi,
    (m, scheme) => `${scheme}${REDACTED}@`,
  ],

  // ── Generic KV secret patterns ────────────────────────────────────────
  [
    'kv_secret',
    /(\b(?:password|passwd|pass|secret|token|api_key|apikey|client_secret)\s*[:=]\s*["']?)([^\s"',;&]{4,})/gi,
    (m, prefix) => `${prefix}${REDACTED}`,
  ],

  // ── PII ───────────────────────────────────────────────────────────────
  // Email addresses
  ['email', /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g],

  // US phone (loose): 10-digit sequences with common separators
  [
    'phone',
    /\b(?:\+1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b/g,
    (m) => {
      // Suppress false positives: version strings, short numbers, port-like
      const digits = m.replace(/\D/g, '');
      return digits.length >= 10 ? REDACTED : m;
    },
  ],

  // Credit card–like (exactly 16 digits, Luhn-valid)
  [
    'card',
    /\b(?:\d[ -]?){15}\d\b/g,
    (m) => luhn(m.replace(/\D/g, '')) ? REDACTED : m,
  ],

  // US SSN
  ['ssn', /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/g],
];

function luhn(digits) {
  let sum = 0;
  let odd = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (odd) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    odd = !odd;
  }
  return sum % 10 === 0;
}

export function redact(text) {
  if (typeof text !== 'string') {
    return typeof text === 'number' || text == null || text === true || text === false
      ? { text: String(text ?? ''), counts: {} }
      : { text: '', counts: {} };
  }
  if (!text) return { text, counts: {} };
  try {
    const counts = {};
    let out = text;
    for (const [name, re, replacer] of RULES) {
      // Reset lastIndex between calls — callers may reuse the module.
      re.lastIndex = 0;
      out = replacer
        ? out.replace(re, (...args) => { const r = replacer(...args); if (r !== args[0]) { counts[name] = (counts[name] ?? 0) + 1; } return r; })
        : out.replace(re, (_m) => { counts[name] = (counts[name] ?? 0) + 1; return REDACTED; });
      re.lastIndex = 0;
    }
    return { text: out, counts };
  } catch {
    return { text, counts: {} };
  }
}
