# Release Audit Fixture

This small release audit tool prepares milestone ordering and risk summaries for
release readiness reviews.

The product team changed milestone inputs to mix ISO date strings and `Date`
objects. Cancelled milestones should be ignored. Risk scoring is intentionally
conservative: failed critical checks block release, failed warnings still count,
and unowned failed checks add operational risk.

Do not rewrite the tool into a different API. The public entry points are
`buildReleasePlan()` and `summarizeAudit()`.
