const SUFFIX = '… [truncated]';

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

function stripHtml(html: string): string {
  return html
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<br\s*\/?>|<\/p\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(lt|gt|quot|#39|nbsp);/g, (_, name: string) => ENTITIES[name]!)
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function cutQuotedHistory(text: string): string {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trimEnd();
    const wraps = line.startsWith('On ') && (lines[i + 1] ?? '').trimEnd().endsWith('wrote:');
    if (/^On .+ wrote:$/.test(line) || wraps) return lines.slice(0, i).join('\n').trimEnd();
  }
  return text;
}

/** Cuts to at most maxChars UTF-16 code units, ending in "… [truncated]", never mid-surrogate-pair. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let keep = maxChars - SUFFIX.length;
  if (keep <= 0) return SUFFIX.slice(0, Math.max(0, maxChars));
  const last = text.charCodeAt(keep - 1);
  if (last >= 0xd800 && last <= 0xdbff) keep--;
  return text.slice(0, keep) + SUFFIX;
}

export function bodyText(parsed: { text?: string; html?: string }, maxChars: number): string {
  const raw = parsed.text ?? (parsed.html !== undefined ? stripHtml(parsed.html) : '');
  return truncate(cutQuotedHistory(raw), maxChars);
}
