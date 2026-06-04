export function loadRuntimeConfig(raw) {
  return {
    endpoint: raw.endpoint,
    timeoutMs: raw.timeoutMs ?? 5000,
  };
}
