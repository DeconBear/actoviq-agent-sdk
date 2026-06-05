export function buildSessionRequest(input) {
  return {
    userId: input.userId,
    retryCount: input.retryCount ?? 3,
    retryDelay: input.retryDelay ?? 250
  };
}

export function assertValidSessionRequest(payload) {
  if (!payload.userId) throw new Error('userId is required');
  if (!Number.isInteger(payload.retryCount) || payload.retryCount < 1) {
    throw new Error('retryCount must be a positive integer');
  }
  return payload;
}
