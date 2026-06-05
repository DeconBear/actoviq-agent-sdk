import { assertValidSessionRequest } from '../../shared/src/schema.js';

export function startSession(request) {
  const payload = assertValidSessionRequest(request);
  return {
    route: '/v1/session',
    session: {
      id: `sess-${payload.userId}`,
      retryCount: payload.retryCount,
      expiresAt: '2026-06-30T00:00:00.000Z'
    },
    headers: {}
  };
}
