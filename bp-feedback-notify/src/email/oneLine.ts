// The event name comes from a free-text board column; a CR/LF in it could inject headers into
// the outbound Subject. Collapses every run of control characters to one space.
export function oneLine(s: string): string {
  return s.replace(/[\r\n\t\x00-\x1f\x7f]+/g, ' ').trim();
}
