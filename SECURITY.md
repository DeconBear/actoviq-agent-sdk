# Security Policy

## Supported versions

Security fixes are provided for the latest Actoviq Agent SDK 1.x minor release. The legacy root compatibility façade remains supported throughout 1.x. Node.js 22.5+ and Node.js 24 are the supported runtime lines.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use the repository's [private vulnerability reporting form](https://github.com/DeconBear/actoviq-agent-sdk/security/advisories/new). Include:

- affected version/commit, Node version, and operating system;
- the smallest reproducible scenario and required configuration;
- security boundary crossed and likely impact;
- whether credentials, tenant data, workspace files, or side effects are involved;
- any known workaround or evidence that exploitation is active.

Avoid including real credentials or private user data. If private reporting is unavailable, open a public issue containing no exploit details and ask a maintainer to establish a private channel.

The maintainers will acknowledge receipt, validate severity, coordinate remediation and disclosure, and publish an advisory when appropriate. Response targets and the full threat/failure policy are documented in [docs/zh/10-support-security-semver-and-failure-model.md](docs/zh/10-support-security-semver-and-failure-model.md).

## Security boundaries

- `LocalIsolatedProcessWorkflowExecutor` reduces ambient access but is not an adversarial multi-tenant sandbox. Use a container or remote sandbox executor for untrusted workloads.
- A timeout or transport error does not prove that a remote side effect did not occur. Reconcile `started` or `unknown` operations before retrying.
- Provider raw responses and legacy unknown blocks may contain sensitive data. They are opt-in or retained for audit and are not replayed across providers by default.
- Hosts remain responsible for provider credentials, exporter retention, tool permission policy, tenant identity, and workspace authorization.
