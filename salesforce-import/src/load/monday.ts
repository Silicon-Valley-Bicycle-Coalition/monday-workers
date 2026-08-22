interface GqlError { message: string; extensions?: { code?: string } }

export class MondayClient {
  private attempts: number;
  constructor(private opts: {
    apiUrl: string; token: string; fetchFn?: typeof fetch;
    sleepFn?: (ms: number) => Promise<void>; maxAttempts?: number;
  }) { this.attempts = opts.maxAttempts ?? 6; }

  async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    const sleep = this.opts.sleepFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    let lastError = '';
    for (let attempt = 0; attempt < this.attempts; attempt++) {
      if (attempt > 0) await sleep(2 ** attempt * 1000 + Math.random() * 500);
      const res = await fetchFn(this.opts.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: this.opts.token,
          'API-Version': '2026-01' },
        body: JSON.stringify({ query, variables }),
      });
      if (res.status === 429) {
        const after = Number(res.headers.get('Retry-After') ?? '0');
        lastError = 'HTTP 429';
        if (after > 0) await sleep(after * 1000);
        continue;
      }
      if (res.status >= 500) { lastError = `HTTP ${res.status}`; continue; }
      if (!res.ok) throw new Error(`monday: HTTP ${res.status}: ${await res.text()}`);
      const body = await res.json() as { data?: T; errors?: GqlError[] };
      if (body.errors?.length) {
        const complexity = body.errors.some((e) =>
          e.extensions?.code === 'ComplexityException' || /complexity/i.test(e.message));
        lastError = body.errors.map((e) => e.message).join('; ');
        if (complexity) continue;
        throw new Error(`monday: ${lastError}`);
      }
      return body.data as T;
    }
    throw new Error(`monday: exhausted ${this.attempts} attempts — last error: ${lastError}`);
  }
}
