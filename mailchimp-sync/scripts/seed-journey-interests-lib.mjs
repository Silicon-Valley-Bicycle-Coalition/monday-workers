// Pure helpers for scripts/seed-journey-interests.mjs, kept apart so vitest can cover them.

/**
 * Renewal Reminders for one existing member: on for a subscribed member tagged active, unless
 * tagged as a Salesforce Renewal Opt Out. Add-only: an interest already on is left out, and
 * nothing is ever sent as false. (Welcome Drip is not seeded: it goes to new members only, turned
 * on by the outbound sync when someone first becomes active.)
 */
export function planRenewal(member, { activeTag, optOutTag, renewalId }) {
  if (member.status !== 'subscribed') return null;
  const tags = new Set((member.tags ?? []).map((t) => t.name));
  if (!tags.has(activeTag) || tags.has(optOutTag)) return null;
  return member.interests?.[renewalId] ? null : { [renewalId]: true };
}

/**
 * Welcome Drip off for a member who joined before `joinedBefore` (YYYY-MM-DD; the API returns
 * MEMBSINCE as YYYY-MM-DD), or has no join date, and has it on: undoes the 2026-11-17 seeding of
 * existing members. Members who joined on or after the date keep it, so a re-run after the sync
 * starts opting new members in doesn't undo theirs.
 */
export function planWelcomeUndo(member, { welcomeId, joinedBefore, sinceField }) {
  if (!member.interests?.[welcomeId]) return null;
  const since = member.merge_fields?.[sinceField] ?? '';
  if (since !== '' && since >= joinedBefore) return null;
  return { [welcomeId]: false };
}

/** Counts by interest change, for the summary. Never holds an address. */
export function countChanges(plans) {
  const out = {};
  for (const p of plans) {
    for (const [id, on] of Object.entries(p.change)) {
      const key = `${id} ${on ? 'on' : 'off'}`;
      out[key] = (out[key] ?? 0) + 1;
    }
  }
  return out;
}
