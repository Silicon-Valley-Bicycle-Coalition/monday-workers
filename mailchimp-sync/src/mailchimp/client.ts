import md5 from 'md5';
import type { MailchimpInterest } from '../types';
import { parseRetryAfter, retryAfterHeader } from '../retryAfter';

export class MailchimpTransientError extends Error {}
export class MailchimpPermanentError extends Error {}
// A 429 — Mailchimp's concurrent-connection limit. Transient, and carries Retry-After (whole
// seconds) when Mailchimp sends one so the queue consumer can wait at least that long.
export class MailchimpRateLimitError extends MailchimpTransientError {
  constructor(message: string, readonly retryAfterSeconds: number | undefined) {
    super(message);
  }
}

// A 401/403 — the API key is invalid, revoked, or lacks access. A deployment problem, not a
// problem with the message: transient so the consumers never ack it — the backlog retries with
// backoff and dead-letters, replayable once the key is fixed, instead of being silently dropped.
export class MailchimpAuthError extends MailchimpTransientError {}

// 429 → rate-limited, 401/403 → auth, 5xx → transient, other 4xx → permanent (retrying a
// malformed request fails identically). `transientOn4xx` is for reads, where any failure has
// always been retried.
async function httpError(op: string, response: Response, transientOn4xx = false): Promise<MailchimpTransientError | MailchimpPermanentError> {
  let detail = '';
  try {
    detail = await response.text();
  } catch {
    // Body unreadable — the status alone still classifies the error.
  }
  const message = `mailchimp ${op}: HTTP ${response.status}${detail === '' ? '' : `: ${detail}`}`;
  if (response.status === 401 || response.status === 403) {
    return new MailchimpAuthError(`${message} (credentials rejected — check the MAILCHIMP_API_KEY secret)`);
  }
  if (response.status === 429) return new MailchimpRateLimitError(message, parseRetryAfter(retryAfterHeader(response)));
  if (response.status >= 500 || transientOn4xx) return new MailchimpTransientError(message);
  return new MailchimpPermanentError(message);
}

export interface MailchimpMemberInterests {
  status: string;
  interests: Record<string, boolean>;
}

export type UpdateMemberResult = 'updated' | 'not-in-audience';
export type UnsubscribeResult = 'unsubscribed' | 'already-unsubscribed' | 'not-in-audience';

export interface MailchimpClient {
  /**
   * Update an existing member's merge fields, then sync its worker-managed tags. Never
   * creates a member: Mailchimp is the consent system of record, so someone absent from
   * the audience stays absent and this returns 'not-in-audience'. `tags` is the desired set;
   * `managedTags` is every tag this worker owns — managed tags not in `tags` are
   * deactivated, and tags outside `managedTags` (staff-applied, other tools') are
   * never touched.
   */
  updateMember(email: string, mergeFields: Record<string, unknown>, tags: string[], managedTags: string[]): Promise<UpdateMemberResult>;
  /**
   * Set an existing member to unsubscribed — the one status change this worker ever makes, and
   * only for a reviewed Do Not Solicit. One-way: nothing here resubscribes anyone. Returns
   * 'already-unsubscribed' (no write) for an unsubscribed or cleaned member, and
   * 'not-in-audience' (no write) for an address Mailchimp doesn't hold.
   */
  unsubscribeMember(email: string): Promise<UnsubscribeResult>;
  getMemberInterests(email: string): Promise<MailchimpMemberInterests | null>;
  listInterests(): Promise<MailchimpInterest[]>;
}

function subscriberHash(email: string): string {
  return md5(email.trim().toLowerCase());
}

let sinkLogged = false;

export class HttpMailchimpClient implements MailchimpClient {
  constructor(
    private apiBaseUrl: string,
    private apiKey: string,
    private audienceId: string,
    // Bound to globalThis: called as `this.fetchFn(...)` below, and an unbound native
    // `fetch` throws "Illegal invocation" when invoked with `this` set to something other
    // than the global scope. Invisible in unit tests (they inject a plain mock function,
    // which doesn't care about `this`) — only surfaced provisioning the sandbox 2026-09-22.
    private fetchFn: typeof fetch = fetch.bind(globalThis),
  ) {}

  // Mailchimp Marketing API auth: HTTP Basic with any non-empty username and the API
  // key as the password (documented behavior, not a real credential pair).
  private authHeader(): string {
    return `Basic ${btoa(`anystring:${this.apiKey}`)}`;
  }

  async updateMember(email: string, mergeFields: Record<string, unknown>, tags: string[], managedTags: string[]): Promise<UpdateMemberResult> {
    if (!sinkLogged) {
      sinkLogged = true;
      // Design doc §6: one line per isolate naming the sink this deployment writes to.
      console.log(JSON.stringify({ sandboxOutbound: 'mailchimp', audienceId: this.audienceId, apiBaseUrl: this.apiBaseUrl }));
    }
    const hash = subscriberHash(email);
    // PATCH, not PUT: a PUT creates the member when missing (with `status_if_new`), which
    // subscribed every Donor with an email on their first column change — including ones
    // who never opted in (issue #28). PATCH 404s instead, and the status of an existing
    // member (subscribed, unsubscribed, cleaned…) is never sent, so never changed.
    const response = await this.fetchFn(
      `${this.apiBaseUrl}/lists/${this.audienceId}/members/${hash}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: this.authHeader() },
        body: JSON.stringify({ merge_fields: mergeFields }),
      },
    );
    if (response.status === 404) return 'not-in-audience';
    if (!response.ok) throw await httpError('updateMember', response);
    await this.syncTags(hash, tags, managedTags);
    return 'updated';
  }

  // Member PUT/PATCH bodies can't change tags on an existing member, so without this
  // explicit sync a lapsed member would keep e.g. svbc-active-member forever. Desired tags go active; managed
  // tags no longer desired go inactive; anything outside the managed set is untouched.
  private async syncTags(hash: string, desired: string[], managed: string[]): Promise<void> {
    const tags = [
      ...desired.map((name) => ({ name, status: 'active' as const })),
      ...managed.filter((name) => !desired.includes(name)).map((name) => ({ name, status: 'inactive' as const })),
    ];
    if (tags.length === 0) return;
    const response = await this.fetchFn(
      `${this.apiBaseUrl}/lists/${this.audienceId}/members/${hash}/tags`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: this.authHeader() },
        body: JSON.stringify({ tags }),
      },
    );
    if (!response.ok) throw await httpError('syncTags', response);
  }

  async unsubscribeMember(email: string): Promise<UnsubscribeResult> {
    const memberUrl = `${this.apiBaseUrl}/lists/${this.audienceId}/members/${subscriberHash(email)}`;
    // Look first: Mailchimp refuses a status change on a cleaned address, and an unsubscribed
    // one needs no write.
    const lookup = await this.fetchFn(`${memberUrl}?fields=status`, { headers: { Authorization: this.authHeader() } });
    if (lookup.status === 404) return 'not-in-audience';
    if (!lookup.ok) throw await httpError('unsubscribeMember lookup', lookup);
    const { status } = (await lookup.json()) as { status: string };
    if (status === 'unsubscribed' || status === 'cleaned') return 'already-unsubscribed';

    const response = await this.fetchFn(memberUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: this.authHeader() },
      body: JSON.stringify({ status: 'unsubscribed' }),
    });
    if (response.ok) return 'unsubscribed';
    throw await httpError('unsubscribeMember', response);
  }

  async getMemberInterests(email: string): Promise<MailchimpMemberInterests | null> {
    const response = await this.fetchFn(
      `${this.apiBaseUrl}/lists/${this.audienceId}/members/${subscriberHash(email)}?fields=status,interests`,
      { headers: { Authorization: this.authHeader() } },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw await httpError('getMemberInterests', response, true);
    const json = (await response.json()) as { status: string; interests?: Record<string, boolean> };
    return { status: json.status, interests: json.interests ?? {} };
  }

  async listInterests(): Promise<MailchimpInterest[]> {
    const categoriesResponse = await this.fetchFn(
      `${this.apiBaseUrl}/lists/${this.audienceId}/interest-categories?count=100`,
      { headers: { Authorization: this.authHeader() } },
    );
    if (!categoriesResponse.ok) throw await httpError('listInterests', categoriesResponse, true);
    const categoriesJson = (await categoriesResponse.json()) as { categories: { id: string }[] };

    const out: MailchimpInterest[] = [];
    for (const category of categoriesJson.categories) {
      const interestsResponse = await this.fetchFn(
        `${this.apiBaseUrl}/lists/${this.audienceId}/interest-categories/${category.id}/interests?count=100`,
        { headers: { Authorization: this.authHeader() } },
      );
      if (!interestsResponse.ok) throw await httpError('listInterests', interestsResponse, true);
      const interestsJson = (await interestsResponse.json()) as { interests: { id: string; name: string }[] };
      for (const interest of interestsJson.interests) {
        out.push({ categoryId: category.id, interestId: interest.id, name: interest.name });
      }
    }
    return out;
  }
}
