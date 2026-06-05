export function redactSecrets(text) {
  return String(text);
}

export function buildAuditSummary(logText) {
  return {
    redacted: redactSecrets(logText),
    secretExposure: true,
    summary: 'raw log copied'
  };
}
