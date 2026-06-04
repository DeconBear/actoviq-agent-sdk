export function buildReleasePlan(config) {
  const milestones = config.milestones ?? [];
  const active = milestones.filter((milestone) => milestone.status !== 'done');
  const sorted = active.sort((left, right) => left.due - right.due);

  return {
    releaseDate: new Date(config.releaseDate).toISOString().slice(0, 10),
    milestoneIds: sorted.map((milestone) => milestone.id),
    nextBlockedMilestone: sorted.find((milestone) => milestone.status === 'blocked')?.id ?? null,
  };
}
