export function buildSessionPayload(config) {
  return {
    token: config.token,
    retries: config.retryCount ?? 3,
  };
}
