import md5 from 'md5';
import type { MailchimpInterest } from '../types';

export class MailchimpTransientError extends Error {}
export class MailchimpPermanentError extends Error {}

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
    if (!response.ok) {
      const detail = await response.text();
      if (response.status === 429 || response.status >= 500) {
        throw new MailchimpTransientError(`mailchimp updateMember: HTTP ${response.status}: ${detail}`);
      }
      throw new MailchimpPermanentError(`mailchimp updateMember: HTTP ${response.status}: ${detail}`);
    }
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
    if (response.ok) return;
    const detail = await response.text();
    if (response.status === 429 || response.status >= 500) {
      throw new MailchimpTransientError(`mailchimp syncTags: HTTP ${response.status}: ${detail}`);
    }
    throw new MailchimpPermanentError(`mailchimp syncTags: HTTP ${response.status}: ${detail}`);
  }

  async unsubscribeMember(email: string): Promise<UnsubscribeResult> {
    const memberUrl = `${this.apiBaseUrl}/lists/${this.audienceId}/members/${subscriberHash(email)}`;
    // Look first: Mailchimp refuses a status change on a cleaned address, and an unsubscribed
    // one needs no write.
    const lookup = await this.fetchFn(`${memberUrl}?fields=status`, { headers: { Authorization: this.authHeader() } });
    if (lookup.status === 404) return 'not-in-audience';
    if (!lookup.ok) {
      const detail = await lookup.text();
      if (lookup.status === 429 || lookup.status >= 500) {
        throw new MailchimpTransientError(`mailchimp unsubscribeMember lookup: HTTP ${lookup.status}: ${detail}`);
      }
      throw new MailchimpPermanentError(`mailchimp unsubscribeMember lookup: HTTP ${lookup.status}: ${detail}`);
    }
    const { status } = (await lookup.json()) as { status: string };
    if (status === 'unsubscribed' || status === 'cleaned') return 'already-unsubscribed';

    const response = await this.fetchFn(memberUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: this.authHeader() },
      body: JSON.stringify({ status: 'unsubscribed' }),
    });
    if (response.ok) return 'unsubscribed';
    const detail = await response.text();
    if (response.status === 429 || response.status >= 500) {
      throw new MailchimpTransientError(`mailchimp unsubscribeMember: HTTP ${response.status}: ${detail}`);
    }
    throw new MailchimpPermanentError(`mailchimp unsubscribeMember: HTTP ${response.status}: ${detail}`);
  }

  async getMemberInterests(email: string): Promise<MailchimpMemberInterests | null> {
    const response = await this.fetchFn(
      `${this.apiBaseUrl}/lists/${this.audienceId}/members/${subscriberHash(email)}?fields=status,interests`,
      { headers: { Authorization: this.authHeader() } },
    );
    if (response.status === 404) return null;
    if (!response.ok) {
      const detail = await response.text();
      throw new MailchimpTransientError(`mailchimp getMemberInterests: HTTP ${response.status}: ${detail}`);
    }
    const json = (await response.json()) as { status: string; interests?: Record<string, boolean> };
    return { status: json.status, interests: json.interests ?? {} };
  }

  async listInterests(): Promise<MailchimpInterest[]> {
    const categoriesResponse = await this.fetchFn(
      `${this.apiBaseUrl}/lists/${this.audienceId}/interest-categories?count=100`,
      { headers: { Authorization: this.authHeader() } },
    );
    if (!categoriesResponse.ok) {
      throw new MailchimpTransientError(`mailchimp listInterests: HTTP ${categoriesResponse.status}`);
    }
    const categoriesJson = (await categoriesResponse.json()) as { categories: { id: string }[] };

    const out: MailchimpInterest[] = [];
    for (const category of categoriesJson.categories) {
      const interestsResponse = await this.fetchFn(
        `${this.apiBaseUrl}/lists/${this.audienceId}/interest-categories/${category.id}/interests?count=100`,
        { headers: { Authorization: this.authHeader() } },
      );
      if (!interestsResponse.ok) {
        throw new MailchimpTransientError(`mailchimp listInterests: HTTP ${interestsResponse.status}`);
      }
      const interestsJson = (await interestsResponse.json()) as { interests: { id: string; name: string }[] };
      for (const interest of interestsJson.interests) {
        out.push({ categoryId: category.id, interestId: interest.id, name: interest.name });
      }
    }
    return out;
  }
}
