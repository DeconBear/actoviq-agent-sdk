export function reconcileReleaseTrain(manifest) {
  return {
    compatible: false,
    blockedItems: manifest.packages.filter((pkg) => pkg.blocked).length,
    waves: [
      { wave: 1, packages: manifest.packages.map((pkg) => pkg.name) }
    ],
    riskSummary: {}
  };
}
