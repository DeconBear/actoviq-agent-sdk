import { buildSessionRequest, assertValidSessionRequest } from '../../shared/src/schema.js';

export function createSessionPayload(input) {
  return assertValidSessionRequest(buildSessionRequest(input));
}

export function normalizeSessionResponse(response) {
  return {
    sessionId: response.session?.id,
    expiresAt: response.session?.expiresAt,
    retryCount: response.session?.retryCount
  };
}
