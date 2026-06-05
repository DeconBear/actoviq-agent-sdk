export function buildRequest(input) {
  return {
    endpoint: '/api/v2/jobs',
    body: {
      jobId: input.jobId,
      timeout: input.timeout ?? 5000,
      retry: input.retry ?? 3
    }
  };
}

export function parseJobResponse(response) {
  return {
    jobId: response.id,
    status: response.status,
    nextPollMs: response.retryAfterMs
  };
}
