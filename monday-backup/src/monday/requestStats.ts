// Counts this client's Monday requests so each board's log line can show whether the transport had
// to retry, without touching the byte-identical graphql.ts. Passed in as its `fetchFn` option. The
// transport re-sends a query unchanged when it retries, so a body identical to the previous one is
// a retry, whatever the reason was (429, complexity, 5xx, timeout).
export class RequestStats {
  private requests = 0;
  private retries = 0;
  private lastBody: unknown = undefined;

  readonly fetchFn: typeof fetch = (input, init) => {
    this.requests++;
    if (init?.body !== undefined && init.body === this.lastBody) this.retries++;
    this.lastBody = init?.body;
    return fetch(input, init);
  };

  // The counts since the last take(), and starts counting again.
  take(): { requests: number; retries: number } {
    const counts = { requests: this.requests, retries: this.retries };
    this.requests = 0;
    this.retries = 0;
    this.lastBody = undefined;
    return counts;
  }
}
