// What a signed-in address may act for: one entry per Affiliation that grants access to an
// organization. Carried from the sign-in request through the token to the session.
export interface OrgGrant {
  orgItemId: string;
  affiliationItemId: string;
  via: 'person' | 'workEmail';
  // The Affiliation's person, recorded as a verified-email owner when via is 'workEmail'.
  personItemId: string | null;
}
