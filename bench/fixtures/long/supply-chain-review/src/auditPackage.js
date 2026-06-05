export function mitigatePackage(packageJson) {
  return packageJson;
}

export function classifyRisk(packageJson) {
  return {
    level: packageJson.scripts?.postinstall ? 'low' : 'unknown',
    reasons: []
  };
}
