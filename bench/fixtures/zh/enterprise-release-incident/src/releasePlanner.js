export function buildReleasePlan(config) {
  const milestones = config.milestones ?? [];
  const sorted = [...milestones].sort((left, right) => String(left.due).localeCompare(String(right.due)));
  return {
    releaseDate: config.releaseDate,
    milestoneIds: sorted.map((milestone) => milestone.id),
    nextBlockedMilestone: sorted.find((milestone) => milestone.status === 'blocked')?.id ?? null
  };
}
