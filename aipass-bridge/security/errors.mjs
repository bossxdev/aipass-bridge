// Stable machine-readable error codes used across the bridge and agent.
// These are returned inside error.code in every JSON error response so callers
// can branch on them reliably without parsing message strings.

export const E = Object.freeze({
  auth_required:      'auth_required',
  auth_invalid:       'auth_invalid',
  origin_forbidden:   'origin_forbidden',
  method_not_allowed: 'method_not_allowed',
  forbidden_path:     'forbidden_path',
  run_disabled:       'run_disabled',
  body_too_large:     'body_too_large',
  not_found:          'not_found',
  upstream_error:     'upstream_error',
  server_error:       'server_error',
});

// Build a standard error response body.
export const errorBody = (code, message, type = 'invalid_request_error') => ({
  error: { code, message, type },
});
