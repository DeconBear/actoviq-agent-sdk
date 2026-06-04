const severityWeights = {
  critical: 4,
  warning: 0,
};

export function summarizeAudit(config) {
  const checks = config.checks ?? [];
  const blockers = checks
    .filter((check) => check.passed === false && check.severity === 'critical')
    .map((check) => check.id);
  const riskScore = checks.reduce((score, check) => {
    if (check.passed) {
      return score;
    }
    return score + (severityWeights[check.severity] ?? 1);
  }, 0);

  return {
    status: riskScore > 7 ? 'blocked' : 'ready',
    blockers,
    riskScore,
    summary: `${riskScore} risk`,
  };
}
