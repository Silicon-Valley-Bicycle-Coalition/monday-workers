import md5 from 'md5';
import type { MailchimpInterest } from '../types';

export class MailchimpTransientError extends Error {}
export class MailchimpPermanentError extends Error {}

export interface MailchimpMemberInterests {
  status: string;
  interests: Record<string, boolean>;
}

export interface MailchimpClient {
  upsertMember(email: string, mergeFields: Record<string, unknown>, tags: string[]): Promise<void>;
  getMemberInterests(email: string): Promise<MailchimpMemberInterests | null>;
  listInterests(): Promise<MailchimpInterest[]>;
}

function subscriberHash(email: string): string {
  return md5(email.trim().toLowerCase());
}

export class HttpMailchimpClient implements MailchimpClient {
  constructor(
    private apiBaseUrl: string,
    private apiKey: string,
    private audienceId: string,
    private fetchFn: typeof fetch = fetch,
  ) {}

  // Mailchimp Marketing API auth: HTTP Basic with any non-empty username and the API
  // key as the password (documented behavior, not a real credential pair).
  private authHeader(): string {
    return `Basic ${btoa(`anystring:${this.apiKey}`)}`;
  }

  async upsertMember(email: string, mergeFields: Record<string, unknown>, tags: string[]): Promise<void> {
    const response = await this.fetchFn(
      `${this.apiBaseUrl}/lists/${this.audienceId}/members/${subscriberHash(email)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: this.authHeader() },
        body: JSON.stringify({
          email_address: email,
          status_if_new: 'subscribed',
          merge_fields: mergeFields,
          tags,
        }),
      },
    );
    if (response.ok) return;
    const detail = await response.text();
    if (response.status === 429 || response.status >= 500) {
      throw new MailchimpTransientError(`mailchimp upsertMember: HTTP ${response.status}: ${detail}`);
    }
    throw new MailchimpPermanentError(`mailchimp upsertMember: HTTP ${response.status}: ${detail}`);
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
