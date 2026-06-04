# Session API v2 Current

Current clients must return a nested payload:

```json
{
  "auth": { "token": "secret" },
  "retry": { "maxAttempts": 3 },
  "telemetry": false
}
```

The `retries` field was renamed to `retry.maxAttempts`.
The top-level `token` field was moved to `auth.token`.
