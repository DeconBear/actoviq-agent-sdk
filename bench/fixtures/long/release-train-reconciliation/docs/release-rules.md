# Release Train Rules

- Blocked packages must not be scheduled.
- Dependencies must be scheduled before dependents.
- No wave may exceed `capacityPerWave`.
- A compatible train should report `blockedItems: 0` after blocked packages are excluded from waves.
