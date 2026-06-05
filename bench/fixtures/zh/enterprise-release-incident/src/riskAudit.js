export function summarizeRisks(config) {
  const failedCritical = (config.checks ?? []).filter((check) => check.severity === 'critical' && check.passed === false);
  return {
    status: failedCritical.length > 0 ? 'blocked' : 'ready',
    blockers: failedCritical.map((check) => check.id),
    riskScore: failedCritical.length * 5,
    summary: `${failedCritical.length} critical blockers`
  };
}
