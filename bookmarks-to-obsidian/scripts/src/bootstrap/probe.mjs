// Liveness probe used for idempotency: does anything answer at `url`? Any HTTP
// response (even an error status) means a server is listening, which is all we
// need to decide "already running, skip launch". Network errors and timeouts
// resolve to false rather than throwing.
export async function probeUrl(url, { timeoutMs = 1500 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.status > 0;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
