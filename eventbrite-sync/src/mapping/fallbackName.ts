// The item name of a registration or volunteer whose attendee has no real name. Never a person's name.
export const fallbackItemName = (attendeeId: string): string => `Eventbrite attendee ${attendeeId}`;

export const isFallbackItemName = (name: string): boolean => /^Eventbrite attendee \d+$/.test(name.trim());
