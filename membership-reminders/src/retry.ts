export interface RetryOptions {
  attempts: number;
  delayMs: number;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < options.attempts) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
    }
  }
  throw lastError;
}
