// Pure helpers for scripts/seed-journey-interests.mjs, kept apart so vitest can cover them.

/**
 * The interests to turn on for one member: both Journey interests for a subscribed member tagged
 * active, except Renewal Reminders for anyone tagged as a Salesforce Renewal Opt Out. Add-only:
 * an interest already on, or one a member turned off themselves, is never sent as false.
 */
export function planMember(member, { activeTag, optOutTag, welcomeId, renewalId }) {
  if (member.status !== 'subscribed') return null;
  const tags = new Set((member.tags ?? []).map((t) => t.name));
  if (!tags.has(activeTag)) return null;
  const interests = member.interests ?? {};
  const turnOn = {};
  if (!interests[welcomeId]) turnOn[welcomeId] = true;
  if (!tags.has(optOutTag) && !interests[renewalId]) turnOn[renewalId] = true;
  return Object.keys(turnOn).length ? turnOn : null;
}

/** Counts for the summary. Never holds an address. */
export function summarize(members, plans, { activeTag, optOutTag, welcomeId, renewalId }) {
  const active = members.filter((m) => m.status === 'subscribed' && (m.tags ?? []).some((t) => t.name === activeTag));
  return {
    activeSubscribed: active.length,
    optedOutOfRenewals: active.filter((m) => m.tags.some((t) => t.name === optOutTag)).length,
    welcomeOn: plans.filter((p) => p.turnOn[welcomeId]).length,
    renewalOn: plans.filter((p) => p.turnOn[renewalId]).length,
  };
}
