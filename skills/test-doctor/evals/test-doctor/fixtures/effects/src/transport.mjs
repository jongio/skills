export class NotSentError extends Error {}
export class RejectedError extends Error {}
export class TimeoutError extends Error {}

export function classify(error) {
  if (error instanceof NotSentError) return "not-sent";
  if (error instanceof RejectedError) return "rejected";
  return "unknown";
}

async function attempt(send, request, signal) {
  if (signal?.aborted) return { state: "not-sent" };
  try {
    await send(request, { signal });
    return { state: "applied" };
  } catch (error) {
    return { state: classify(error), error };
  }
}

export function combine(attempts) {
  if (attempts.some((item) => item.state === "applied")) return "applied";
  if (attempts.some((item) => item.state === "unknown")) return "unknown";
  if (attempts.some((item) => item.state === "rejected")) return "rejected";
  return "not-sent";
}

export async function deliver(request, { primary, fallback, retries = 1, signal } = {}) {
  const attempts = [];
  for (let index = 0; index <= retries; index += 1) {
    const result = await attempt(primary, request, signal);
    attempts.push(result);
    if (!(result.error instanceof TimeoutError)) break;
  }
  if (fallback && attempts.every((item) => item.state === "not-sent") && !signal?.aborted) {
    attempts.push(await attempt(fallback, request, signal));
  }
  return { state: combine(attempts), attempts: attempts.length };
}
