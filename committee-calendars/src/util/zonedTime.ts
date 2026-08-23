function getTimeZoneOffsetMinutes(instant: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = formatter.formatToParts(instant);
  const get = (type: string): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) {
      throw new Error(`zonedTime: missing "${type}" part from Intl.DateTimeFormat output`);
    }
    return Number(part.value);
  };
  const hour = get('hour');
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), hour === 24 ? 0 : hour, get('minute'), get('second'));
  return (asUtc - instant.getTime()) / 60000;
}

/**
 * Converts a naive wall-clock time in `timeZone` to the UTC instant it represents,
 * correctly accounting for that zone's DST offset at that specific date.
 */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const firstOffset = getTimeZoneOffsetMinutes(utcGuess, timeZone);
  const refined = new Date(utcGuess.getTime() - firstOffset * 60000);
  const secondOffset = getTimeZoneOffsetMinutes(refined, timeZone);
  return new Date(utcGuess.getTime() - secondOffset * 60000);
}
