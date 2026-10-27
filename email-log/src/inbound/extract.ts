import type { Address, Attachment, Email } from 'postal-mime';
import type { EmailLogConfig } from '../types';
import { bodyText, rawText } from './body';
import type { DedupeSource } from './dedupe';
import { parseForwardBlock } from './forwardBlock';
import type { WriteStamp } from '../flags';

export interface LogQueueMessage extends WriteStamp {
  messageIdHash: string;
  kind: 'bcc' | 'forward';
  staffEmail: string;
  counterparts: string[]; // lowercased bare addresses, deduped, staff and loggingAddress removed
  subject: string; // 'Fwd:' prefix removed on forwards; '(no subject)' when empty
  dateISO: string;
  body: string; // already truncated
  attachmentNames: string[];
}

export type Extracted =
  | { kind: 'log'; message: Omit<LogQueueMessage, 'messageIdHash' | 'staffEmail'>; dedupeSource: DedupeSource }
  | { kind: 'staff-only' };

const FORWARD_SUBJECT = /^\s*(?:fwd?|fw)\s*:/i;
const FORWARD_PREFIXES = /^(?:\s*(?:fwd?|fw)\s*:)+\s*/i;

function addresses(list: Address[] | Address | undefined): string[] {
  const entries = Array.isArray(list) ? list : list ? [list] : [];
  return entries
    .flatMap((a) => ('group' in a && a.group ? a.group : [a]))
    .flatMap((m) => ('address' in m && m.address ? [m.address.trim().toLowerCase()] : []));
}

// An image the HTML shows in place (a signature logo, a pasted screenshot) rather than a file the
// sender attached: postal-mime marks a Content-ID part inside multipart/related as `related`, and
// an inline part with a Content-ID is embedded the same way. Apple Mail sends real files as inline
// without a Content-ID, so the disposition alone doesn't decide.
function isEmbedded(a: Attachment): boolean {
  return a.related === true || (a.disposition === 'inline' && a.contentId !== undefined);
}

function validDate(value: string | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Classifies a parsed inbound message and pulls out what the Monday write needs. `now` is the
 * last-resort date only, injected so extraction stays deterministic.
 */
export function extract(parsed: Email, mail: EmailLogConfig['mail'], now: Date): Extracted {
  const staffDomains = mail.staffDomains.map((d) => d.toLowerCase());
  const logging = mail.loggingAddress.toLowerCase();
  const isStaff = (addr: string) => staffDomains.includes(addr.slice(addr.lastIndexOf('@') + 1));
  const external = (list: string[]) => [...new Set(list)].filter((a) => a !== logging && !isStaff(a));

  const rawSubject = (parsed.subject ?? '').trim();
  const messageDate = validDate(parsed.date) ?? now.toISOString();
  const attachmentNames = parsed.attachments.flatMap((a) => (a.filename && !isEmbedded(a) ? [a.filename] : []));

  const forwardLike = FORWARD_SUBJECT.test(rawSubject);
  const block = forwardLike ? parseForwardBlock(rawText(parsed), mail.forwardTimeZone) : null;

  if (block) {
    const counterparts = external(isStaff(block.from) ? [...block.to, ...block.cc] : [block.from, ...block.cc]);
    if (counterparts.length === 0) return { kind: 'staff-only' };
    const forwardSubject = rawSubject.replace(FORWARD_PREFIXES, '').trim();
    const subject = forwardSubject || block.subject.trim() || '(no subject)';
    const dateISO = block.dateISO ?? messageDate;
    return {
      kind: 'log',
      message: {
        kind: 'forward',
        counterparts,
        subject,
        dateISO,
        body: bodyText({ text: block.body }, mail.bodyMaxChars),
        attachmentNames,
      },
      dedupeSource: block.messageId
        ? { messageId: block.messageId }
        : { from: block.from, dateISO, subject },
    };
  }

  const counterparts = external([...addresses(parsed.to), ...addresses(parsed.cc)]);
  // A Fwd: subject whose block did not parse is still logged (the consumer makes a Needs Person
  // item and replies); only a plain BCC with no external counterpart is dropped as staff-only.
  if (counterparts.length === 0 && !forwardLike) return { kind: 'staff-only' };
  const subject = rawSubject || '(no subject)';
  return {
    kind: 'log',
    message: {
      kind: 'bcc',
      counterparts,
      subject,
      dateISO: messageDate,
      body: bodyText(parsed, mail.bodyMaxChars),
      attachmentNames,
    },
    dedupeSource: parsed.messageId
      ? { messageId: parsed.messageId }
      : { from: addresses(parsed.from)[0] ?? '', dateISO: messageDate, subject },
  };
}
