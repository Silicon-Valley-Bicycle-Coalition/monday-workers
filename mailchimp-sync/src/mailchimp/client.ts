import { memberId } from '../logSafe';
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

// Part of every MailchimpAuthError message. The consumers store err.message on the pending row,
// so this is how the dead-letter consumer (which only has the row) recognizes a rejected key.
export const CREDENTIALS_REJECTED_MARKER = 'credentials rejected — check the MAILCHIMP_API_KEY secret';

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
    return new MailchimpAuthError(`${message} (${CREDENTIALS_REJECTED_MARKER})`);
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
export type RenameMemberResult = 'renamed' | 'target-exists' | 'not-in-audience';
export type UnsubscribeResult = 'unsubscribed' | 'already-unsubscribed' | 'not-in-audience';
// The managed tag set, or a reader for it that updateMember calls only once the PATCH has found
// the member, so a caller that needs the member's current tags to build it pays for that read
// only on a member that exists (GL#97).
export type ManagedTags = string[] | (() => Promise<string[]>);

export interface MailchimpClient {
  /**
   * Update an existing member's merge fields, then sync its worker-managed tags. Never
   * creates a member: Mailchimp is the consent system of record, so someone absent from
   * the audience stays absent and this returns 'not-in-audience'. `tags` is the desired set;
   * `managedTags` is every tag this worker owns — managed tags not in `tags` are
   * deactivated, and tags outside `managedTags` (staff-applied, other tools') are
   * never touched. Given as a reader, it is called after the merge-field PATCH succeeds.
   */
  updateMember(email: string, mergeFields: Record<string, unknown>, tags: string[], managedTags: ManagedTags): Promise<UpdateMemberResult>;
  /**
   * Move an existing member from `oldEmail` to `newEmail` after staff change a Donor's address
   * on Monday. Only `email_address` is sent, so the member's status (its consent), tags and
   * history carry over unchanged. Never creates a member and never merges two: 'target-exists'
   * (no write) when `newEmail` is already in the audience or is the same member, and
   * 'not-in-audience' when `oldEmail` isn't.
   */
  renameMember(oldEmail: string, newEmail: string): Promise<RenameMemberResult>;
  /**
   * Set an existing member to unsubscribed — the one status change this worker ever makes, and
   * only for a reviewed Do Not Solicit. One-way: nothing here resubscribes anyone. Returns
   * 'already-unsubscribed' (no write) for an unsubscribed or cleaned member, and
   * 'not-in-audience' (no write) for an address Mailchimp doesn't hold.
   */
  unsubscribeMember(email: string): Promise<UnsubscribeResult>;
  /**
   * The names of the tags currently on a member (up to 1000), [] for an address not in the
   * audience. Read (through updateMember's managed-tags reader) so the Nearby tags it should
   * deactivate can be named.
   */
  getMemberTagNames(email: string): Promise<string[]>;
  getMemberInterests(email: string): Promise<MailchimpMemberInterests | null>;
  /**
   * Every interest in the given categories. Throws if a category isn't in the audience: a
   * mistyped id would otherwise read as "no interests", and the reconcile would archive every
   * Campaigns item.
   */
  listInterests(categoryIds: readonly string[]): Promise<MailchimpInterest[]>;
}

let sinkLogged = false;

// Per-request bound on every Mailchimp call (GL#73): the queues run at max_concurrency 1, so one hung
// request would otherwise stall every message behind it. Matches the Monday client's
// requestTimeoutMs. A timeout throws a plain TimeoutError, which the consumers retry.
const REQUEST_TIMEOUT_MS = 20_000;

// The audience marks City, County, First and Last Name required, and ~1,800 contacts (mostly
// imported from Salesforce) have one blank. Mailchimp checks every required field on every member
// PATCH, not just the ones sent, so without this each write to such a contact fails with a 400
// "Your merge fields were invalid", whatever it changes. Nothing here can fill those fields in.
const SKIP_MERGE_VALIDATION = '?skip_merge_validation=true';

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

  private request(url: string, init: RequestInit): Promise<Response> {
    return this.fetchFn(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }

  // Mailchimp Marketing API auth: HTTP Basic with any non-empty username and the API
  // key as the password (documented behavior, not a real credential pair).
  private authHeader(): string {
    return `Basic ${btoa(`anystring:${this.apiKey}`)}`;
  }

  async updateMember(email: string, mergeFields: Record<string, unknown>, tags: string[], managedTags: ManagedTags): Promise<UpdateMemberResult> {
    if (!sinkLogged) {
      sinkLogged = true;
      // Design doc §6: one line per isolate naming the sink this deployment writes to.
      console.log(JSON.stringify({ sandboxOutbound: 'mailchimp', audienceId: this.audienceId, apiBaseUrl: this.apiBaseUrl }));
    }
    const hash = memberId(email);
    // PATCH, not PUT: a PUT creates the member when missing (with `status_if_new`), which
    // subscribed every Donor with an email on their first column change — including ones
    // who never opted in (issue GL#28). PATCH 404s instead, and the status of an existing
    // member (subscribed, unsubscribed, cleaned…) is never sent, so never changed.
    const response = await this.request(
      `${this.apiBaseUrl}/lists/${this.audienceId}/members/${hash}${SKIP_MERGE_VALIDATION}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: this.authHeader() },
        body: JSON.stringify({ merge_fields: mergeFields }),
      },
    );
    if (response.status === 404) return 'not-in-audience';
    if (!response.ok) throw await httpError('updateMember', response);
    await this.syncTags(hash, tags, typeof managedTags === 'function' ? await managedTags() : managedTags);
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
    const response = await this.request(
      `${this.apiBaseUrl}/lists/${this.audienceId}/members/${hash}/tags`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: this.authHeader() },
        body: JSON.stringify({ tags }),
      },
    );
    if (!response.ok) throw await httpError('syncTags', response);
  }

  async renameMember(oldEmail: string, newEmail: string): Promise<RenameMemberResult> {
    if (memberId(oldEmail) === memberId(newEmail)) return 'target-exists';
    const membersUrl = `${this.apiBaseUrl}/lists/${this.audienceId}/members`;
    // Look first: Mailchimp refuses to rename onto an address it already holds, and two members
    // are never merged here — that address's own consent stays as it is.
    const lookup = await this.request(`${membersUrl}/${memberId(newEmail)}?fields=status`, { headers: { Authorization: this.authHeader() } });
    if (lookup.ok) return 'target-exists';
    if (lookup.status !== 404) throw await httpError('renameMember lookup', lookup);

    const response = await this.request(`${membersUrl}/${memberId(oldEmail)}${SKIP_MERGE_VALIDATION}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: this.authHeader() },
      body: JSON.stringify({ email_address: newEmail.trim() }),
    });
    if (response.status === 404) return 'not-in-audience';
    if (response.ok) return 'renamed';
    throw await httpError('renameMember', response);
  }

  async unsubscribeMember(email: string): Promise<UnsubscribeResult> {
    const memberUrl = `${this.apiBaseUrl}/lists/${this.audienceId}/members/${memberId(email)}`;
    // Look first: Mailchimp refuses a status change on a cleaned address, and an unsubscribed
    // one needs no write.
    const lookup = await this.request(`${memberUrl}?fields=status`, { headers: { Authorization: this.authHeader() } });
    if (lookup.status === 404) return 'not-in-audience';
    if (!lookup.ok) throw await httpError('unsubscribeMember lookup', lookup);
    const { status } = (await lookup.json()) as { status: string };
    if (status === 'unsubscribed' || status === 'cleaned') return 'already-unsubscribed';

    const response = await this.request(`${memberUrl}${SKIP_MERGE_VALIDATION}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: this.authHeader() },
      body: JSON.stringify({ status: 'unsubscribed' }),
    });
    if (response.ok) return 'unsubscribed';
    throw await httpError('unsubscribeMember', response);
  }

  async getMemberTagNames(email: string): Promise<string[]> {
    const response = await this.request(
      `${this.apiBaseUrl}/lists/${this.audienceId}/members/${memberId(email)}/tags?count=1000`,
      { headers: { Authorization: this.authHeader() } },
    );
    if (response.status === 404) return [];
    // Like the other reads, any failure is retried rather than acked.
    if (!response.ok) throw await httpError('getMemberTagNames', response, true);
    const json = (await response.json()) as { tags?: { name: string }[] };
    return (json.tags ?? []).map((tag) => tag.name);
  }

  async getMemberInterests(email: string): Promise<MailchimpMemberInterests | null> {
    const response = await this.request(
      `${this.apiBaseUrl}/lists/${this.audienceId}/members/${memberId(email)}?fields=status,interests`,
      { headers: { Authorization: this.authHeader() } },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw await httpError('getMemberInterests', response, true);
    const json = (await response.json()) as { status: string; interests?: Record<string, boolean> };
    return { status: json.status, interests: json.interests ?? {} };
  }

  async listInterests(categoryIds: readonly string[]): Promise<MailchimpInterest[]> {
    const categoriesResponse = await this.request(
      `${this.apiBaseUrl}/lists/${this.audienceId}/interest-categories?count=100`,
      { headers: { Authorization: this.authHeader() } },
    );
    if (!categoriesResponse.ok) throw await httpError('listInterests', categoriesResponse, true);
    const categoriesJson = (await categoriesResponse.json()) as { categories: { id: string }[] };
    const present = new Set(categoriesJson.categories.map((category) => category.id));
    const missing = categoryIds.filter((id) => !present.has(id));
    if (missing.length > 0) {
      throw new Error(`mailchimp listInterests: interest categories not in the audience: ${missing.join(', ')} (check mailchimp.interestCategoryIds)`);
    }

    const out: MailchimpInterest[] = [];
    for (const category of categoriesJson.categories.filter((c) => categoryIds.includes(c.id))) {
      const interestsResponse = await this.request(
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
