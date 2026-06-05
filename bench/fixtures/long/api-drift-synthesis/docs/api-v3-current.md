# API v3 Current

Current endpoint: `/api/v3/jobs`.

Request fields:

- `jobId`
- `requestTimeoutMs`
- `maxAttempts`
- `idempotencyKey`

Response shape:

- `job.id`
- `job.state`
- `retry.nextPollMs`
