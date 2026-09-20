import type { MondayClient } from '../monday/client';
import type { EventRegistrationRecord, EventRegistrationsConfig } from '../types';

export interface EventRegistrationListing {
  donorId: string;
  donorName: string;
  upcoming: EventRegistrationRecord[];
  past: EventRegistrationRecord[];
}

// Dates are Monday date-column text ("YYYY-MM-DD"), so plain string comparison orders them.
// An event on today's date still counts as upcoming — a donor checking the portal on event day
// should find it under "upcoming", not already archived.
export async function loadEventRegistrations(
  donorItemIds: string[],
  monday: MondayClient,
  config: EventRegistrationsConfig,
  now: Date
): Promise<EventRegistrationListing[]> {
  const today = now.toISOString().slice(0, 10);
  const names = new Map((await monday.getDonorNames(donorItemIds)).map((d) => [d.id, d.name]));

  return Promise.all(
    donorItemIds.map(async (donorItemId) => {
      const records = await monday.getEventRegistrationsForDonor({
        donorItemId,
        boardId: config.boardId ?? 0,
        columns: config.columns,
        eventDateColumnId: config.eventDateColumnId,
      });

      const upcoming = records
        .filter((r) => r.eventDate >= today)
        .sort((a, b) => a.eventDate.localeCompare(b.eventDate));
      // "" sorts before every real date, so undated registrations land last in the
      // latest-first past list — they can never be claimed as upcoming.
      const past = records
        .filter((r) => r.eventDate < today)
        .sort((a, b) => b.eventDate.localeCompare(a.eventDate));

      return {
        donorId: donorItemId,
        donorName: names.get(donorItemId) ?? donorItemId,
        upcoming,
        past,
      };
    })
  );
}
