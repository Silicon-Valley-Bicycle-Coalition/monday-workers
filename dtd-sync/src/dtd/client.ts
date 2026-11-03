import type { DtdDonation, DtdRegistration } from './types';

export type { DtdDonation, DtdRegistration } from './types';

export class DtdAuthError extends Error {}

export class DtdApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function str(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toDonation(raw: Record<string, unknown>): DtdDonation {
  return {
    // Numeric for Funraise gifts (8 digits), string for others.
    donation_identifier: String(raw.donation_identifier),
    source: str(raw.source),
    donation_datetime: str(raw.donation_datetime),
    donor_email: str(raw.donor_email),
    company_name: str(raw.company_name),
    doublethedonation_company_id:
      typeof raw.doublethedonation_company_id === 'number' ? raw.doublethedonation_company_id : str(raw.doublethedonation_company_id),
    status: str(raw.status),
    matching_gift_status: str(raw.matching_gift_status),
    employer_identification_status: str(raw.employer_identification_status),
    matched_amount: num(raw.matched_amount),
    plugin_link: str(raw.plugin_link),
  };
}

export class DtdClient {
  constructor(
    private readonly apiBase: string,
    private readonly privateKey: string,
    private readonly publicKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async getUpdatedDonations(sinceISO: string, toISO: string): Promise<DtdDonation[]> {
    const url = this.url('get_updated_donations', { since: sinceISO, to: toISO });
    const res = await this.send(url, { method: 'GET' });
    const body: unknown = await res.json().catch(() => null);
    if (!Array.isArray(body)) throw new DtdApiError(`DTD ${new URL(url).pathname} returned a non-array body`, res.status);
    return body.map((d) => toDonation(d as Record<string, unknown>));
  }

  async registerDonation(body: DtdRegistration): Promise<void> {
    const url = this.url('register_donation', {});
    await this.send(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, '360matchpro_public_key': this.publicKey }),
    });
  }

  private url(endpoint: string, params: Record<string, string>): string {
    const base = this.apiBase.endsWith('/') ? this.apiBase : `${this.apiBase}/`;
    const u = new URL(endpoint, base);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set('key', this.privateKey);
    return u.toString();
  }

  // Errors carry only the URL pathname and HTTP status, never the query string (it holds the key).
  private async send(url: string, init: RequestInit): Promise<Response> {
    const path = new URL(url).pathname;
    let res: Response;
    try {
      res = await this.fetchFn(url, init);
    } catch {
      throw new DtdApiError(`DTD ${path} request failed (network error)`, 0);
    }
    if (res.status === 401 || res.status === 403) throw new DtdAuthError(`DTD ${path} rejected the API key (HTTP ${res.status})`);
    if (!res.ok) throw new DtdApiError(`DTD ${path} failed with HTTP ${res.status}`, res.status);
    return res;
  }
}
