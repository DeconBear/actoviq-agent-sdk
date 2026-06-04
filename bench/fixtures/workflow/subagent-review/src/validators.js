export function validateConfig(config) {
  return Boolean(config.model && config.timeoutMs > 1000);
}

export function validateReport(report) {
  return report.state === 'ready' && report.checks.every((check) => check.ok === true);
}
