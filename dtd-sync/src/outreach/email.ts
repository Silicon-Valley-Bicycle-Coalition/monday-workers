// The post-gift matching email. The copy here is what config.outreach.wordingApprovedOn approves:
// change a sentence and the approval is stale (README, "Post-gift email").
import type { OutreachConfig } from '../config';
import { escapeHtml } from '../email/escapeHtml';
import { renderEmailLayout } from '../email/layout';
import type { PromptVariant } from './employers';

export interface PromptEmailInput { variant: PromptVariant; firstName: string; amount: number; giftDate: string }
export interface PromptEmail { subject: string; html: string; text: string }

const SUBJECT = 'Your gift to SVBC could go twice as far';
const ORGANIZATION = 'Silicon Valley Bicycle Coalition';

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const longDate = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' });

const paragraph = (html: string): string => `<p>${html}</p>`;
const button = (label: string, url: string): string =>
  `<p style="margin:24px 0;"><a href="${escapeHtml(url)}" style="display:inline-block; background:#FFC20E; color:#000000; padding:12px 20.8px; border-radius:300px; text-decoration:none; font-size:16px;">${escapeHtml(label)}</a></p>`;

/** Throws for an `ask` email while employerFormUrl is null: there is nowhere to send the donor. */
export function renderPromptEmail(input: PromptEmailInput, cfg: OutreachConfig): PromptEmail {
  const name = input.firstName.replace(/\s+/g, ' ').trim();
  const greeting = `Hi ${name === '' ? 'there' : name},`;
  const amount = money.format(input.amount);
  const date = longDate.format(new Date(`${input.giftDate}T00:00:00Z`));
  const thanks = `Thank you for your ${amount} gift on ${date}.`;

  const html: string[] = [paragraph(escapeHtml(greeting))];
  const text: string[] = [greeting];

  if (input.variant.kind === 'known') {
    const { employer } = input.variant;
    const matches = `${employer.name} matches employee donations`;
    text.push(`${thanks} ${matches}, so one form could double it.`);
    html.push(paragraph(`${escapeHtml(thanks)} <strong>${escapeHtml(matches)}</strong>, so one form could double it.`));

    // steps: 'benevity-off-platform', the only template so far.
    const steps = [
      `Sign in to ${employer.name}'s giving portal and choose to request a match for a donation made elsewhere.`,
      `Search for ${ORGANIZATION} (EIN ${cfg.ein}).`,
      `Enter ${amount}, dated ${date}, and attach this email or your receipt.`,
    ];
    text.push(steps.map((s, i) => `${i + 1}. ${s}`).join('\n'));
    html.push(`<ol>${steps.map((s) => `<li>${escapeHtml(s).replace(ORGANIZATION, `<strong>${ORGANIZATION}</strong>`)}</li>`).join('')}</ol>`);

    if (employer.deadlineNote !== null) {
      const deadline = `${employer.name} accepts requests ${employer.deadlineNote}.`;
      text.push(deadline);
      html.push(paragraph(escapeHtml(deadline)));
    }
    if (employer.requestUrl !== null) {
      text.push(`Request your match: ${employer.requestUrl}`);
      html.push(button('Request your match', employer.requestUrl));
    }
  } else {
    if (cfg.employerFormUrl === null) throw new Error('renderPromptEmail: outreach.employerFormUrl is null');
    const question = `${thanks} Many Bay Area employers match their employees' gifts. Where do you work? Tell us, and we'll let you know if yours matches.`;
    text.push(question, `Tell us where you work: ${cfg.employerFormUrl}`);
    html.push(paragraph(escapeHtml(question)), button('Tell us where you work', cfg.employerFormUrl));
  }

  const why = `You're getting this because you gave to SVBC on ${date}. Reply to this email to stop matching-gift emails.`;
  text.push(`${why}\n${cfg.postalAddress}`);
  html.push(`<p class="em-muted" style="color:#666666; font-size:12px;">${escapeHtml(why)}<br>${escapeHtml(cfg.postalAddress)}</p>`);

  const body = renderEmailLayout({ bodyHtml: html.join('\n'), bodyText: text.join('\n\n'), logoUrl: cfg.logoUrl });
  return { subject: SUBJECT, html: body.html, text: body.text };
}
