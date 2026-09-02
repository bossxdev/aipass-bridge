import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redact } from '../security/dlp.mjs';

// Helper: assert text was changed and the named count incremented.
function assertRedacted(result, name, expectedSubstring = '[REDACTED]') {
  assert.ok(
    result.text.includes(expectedSubstring),
    `expected [REDACTED] in: ${result.text}`,
  );
  assert.ok(
    (result.counts[name] ?? 0) >= 1,
    `expected counts.${name} >= 1, got ${JSON.stringify(result.counts)}`,
  );
}

// Helper: assert text was NOT changed.
function assertClean(result, original) {
  assert.equal(result.text, original);
  assert.deepEqual(result.counts, {});
}

describe('dlp.redact', () => {
  // ── Private keys ────────────────────────────────────────────────────────────
  it('redacts RSA private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAK\n-----END RSA PRIVATE KEY-----';
    assertRedacted(redact(pem), 'private_key');
  });

  it('redacts EC private key block', () => {
    const pem = '-----BEGIN EC PRIVATE KEY-----\ndata\n-----END EC PRIVATE KEY-----';
    assertRedacted(redact(pem), 'private_key');
  });

  // ── AWS ─────────────────────────────────────────────────────────────────────
  it('redacts AWS access key', () => {
    assertRedacted(redact('key=AKIAIOSFODNN7EXAMPLE here'), 'aws_access_key');
  });

  it('redacts aws_secret_access_key = value', () => {
    const r = redact('aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    assertRedacted(r, 'aws_secret_key');
  });

  // ── Provider tokens ─────────────────────────────────────────────────────────
  it('redacts Anthropic key sk-ant-…', () => {
    assertRedacted(redact('token: sk-ant-api03-' + 'x'.repeat(30)), 'anthropic_key');
  });

  it('redacts OpenAI key sk-…', () => {
    assertRedacted(redact('key=sk-' + 'A'.repeat(48)), 'openai_key');
  });

  it('redacts OpenAI project key sk-proj-…', () => {
    assertRedacted(redact('sk-proj-' + 'a'.repeat(30)), 'openai_key');
  });

  it('redacts GitHub PAT ghp_…', () => {
    assertRedacted(redact('token=ghp_' + 'a'.repeat(30)), 'github_token');
  });

  it('redacts GitHub PAT github_pat_…', () => {
    assertRedacted(redact('github_pat_' + 'a'.repeat(30)), 'github_token');
  });

  it('redacts Slack token xoxb-…', () => {
    assertRedacted(redact('xoxb-1234567890-1234567890123-' + 'a'.repeat(20)), 'slack_token');
  });

  it('redacts Google API key AIza…', () => {
    assertRedacted(redact('AIzaSy' + 'A'.repeat(33)), 'google_key');
  });

  // ── Bearer / Authorization headers ─────────────────────────────────────────
  it('redacts Authorization: Bearer token', () => {
    const r = redact('Authorization: Bearer eyABC' + 'x'.repeat(25));
    assertRedacted(r, 'bearer_token');
  });

  it('redacts bare bearer token', () => {
    const r = redact('bearer ' + 'a'.repeat(20));
    assertRedacted(r, 'bearer_token');
  });

  // ── JWTs ────────────────────────────────────────────────────────────────────
  it('redacts JWT eyJ…', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def456';
    assertRedacted(redact(`header ${jwt}`), 'jwt');
  });

  // ── Connection strings ──────────────────────────────────────────────────────
  it('redacts postgres connection string with credentials', () => {
    const r = redact('postgres://admin:Hunter2@localhost:5432/db');
    assertRedacted(r, 'connection_string');
    assert.ok(!r.text.includes('Hunter2'), 'password must not appear in output');
  });

  it('leaves connection string without credentials unchanged', () => {
    assertClean(redact('postgres://localhost:5432/db'), 'postgres://localhost:5432/db');
  });

  // ── KV secrets ──────────────────────────────────────────────────────────────
  it('redacts password=value', () => {
    assertRedacted(redact('password=myS3cretPass'), 'kv_secret');
  });

  it('redacts password: "quoted"', () => {
    assertRedacted(redact('password: "quoted-pass-99"'), 'kv_secret');
  });

  it('redacts secret=value', () => {
    assertRedacted(redact('secret=topsecretvalue'), 'kv_secret');
  });

  it('redacts api_key=value', () => {
    assertRedacted(redact('api_key=abcdefghijklmno'), 'kv_secret');
  });

  it('does NOT false-positive on compass=value (no word boundary)', () => {
    const r = redact('compass=notasecret');
    assertClean(r, 'compass=notasecret');
  });

  // ── PII ─────────────────────────────────────────────────────────────────────
  it('redacts email address', () => {
    assertRedacted(redact('reach me at user@example.com ok'), 'email');
  });

  it('redacts US phone number', () => {
    assertRedacted(redact('call (555) 123-4567 now'), 'phone');
  });

  it('does NOT false-positive on version string as phone', () => {
    const r = redact('node v20.1.0 ok');
    assertClean(r, 'node v20.1.0 ok');
  });

  it('redacts Luhn-valid credit card', () => {
    assertRedacted(redact('card 4111 1111 1111 1111 ok'), 'card');
  });

  it('does NOT redact Luhn-invalid number', () => {
    const r = redact('not-a-card 4111111111111112');
    assert.ok(!r.text.includes('[REDACTED]'));
  });

  it('redacts US SSN', () => {
    assertRedacted(redact('ssn 123-45-6789 on file'), 'ssn');
  });

  // ── Safe inputs ─────────────────────────────────────────────────────────────
  it('leaves plain text unchanged', () => {
    assertClean(redact('just plain source code here'), 'just plain source code here');
  });

  it('returns empty counts for text with no matches', () => {
    const { counts } = redact('function hello() { return 42; }');
    assert.deepEqual(counts, {});
  });

  // ── Edge / type coercion ─────────────────────────────────────────────────────
  it('handles empty string', () => {
    const r = redact('');
    assert.equal(r.text, '');
    assert.deepEqual(r.counts, {});
  });

  it('handles null gracefully', () => {
    const r = redact(null);
    assert.equal(r.text, '');
    assert.deepEqual(r.counts, {});
  });

  it('handles number gracefully', () => {
    const r = redact(123);
    assert.equal(r.text, '123');
  });

  it('handles boolean gracefully', () => {
    const r = redact(true);
    assert.equal(r.text, 'true');
  });

  // ── Idempotency ──────────────────────────────────────────────────────────────
  it('is idempotent: redacting twice gives the same result', () => {
    const input = 'email user@example.com and key sk-' + 'a'.repeat(30);
    const once = redact(input).text;
    const twice = redact(once).text;
    assert.equal(once, twice);
  });

  // ── No value leakage in counts ────────────────────────────────────────────────
  it('counts contain only category names, not secret values', () => {
    const secret = 'sk-ant-api03-' + 'z'.repeat(40);
    const { counts } = redact(`token: ${secret}`);
    const serialised = JSON.stringify(counts);
    assert.ok(!serialised.includes(secret), 'secret value leaked into counts');
    assert.ok(!serialised.includes('sk-ant'), 'partial secret leaked into counts');
  });
});
