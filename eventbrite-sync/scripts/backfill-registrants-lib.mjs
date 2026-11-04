// Pure planning for backfill-registrants-link.mjs: which registrations still need the two-way link.

export function planRegistrantsLinks(registrations, excludedEventItemIds) {
  const excluded = new Set(excludedEventItemIds);
  const plan = { toLink: [], alreadyLinked: 0, excluded: 0, noEvent: 0 };
  for (const { itemId, eventItemId, registrantsLinked } of registrations) {
    if (registrantsLinked) plan.alreadyLinked++;
    else if (eventItemId === null) plan.noEvent++;
    else if (excluded.has(eventItemId)) plan.excluded++;
    else plan.toLink.push({ itemId, eventItemId });
  }
  return plan;
}
