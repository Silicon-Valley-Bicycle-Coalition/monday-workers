import type { Digest, Table } from './digests';
import { escapeHtml } from './email/escapeHtml';
import { renderEmailLayout, type RenderedEmail } from './email/layout';

const CELL = 'padding:4px 8px; border-bottom:1px solid #DDDDDD; text-align:left; vertical-align:top; font-size:13px;';

function tableHtml(t: Table, viewUrl: string | null): string {
  const head = t.headers.map((h) => `<th style="${CELL} font-weight:600;">${escapeHtml(h)}</th>`).join('');
  const rows = t.rows.map((r) => `<tr>${r.map((c) => `<td style="${CELL}">${escapeHtml(c)}</td>`).join('')}</tr>`).join('\n');
  const more = t.more > 0
    ? `<p>…and ${t.more} more${viewUrl ? ` — <a href="${escapeHtml(viewUrl)}">see them all in Monday</a>` : ''}.</p>` : '';
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse; width:100%;"><tr>${head}</tr>\n${rows}</table>${more}`;
}

function tableText(t: Table): string {
  const lines = t.rows.map((r) => r.map((c, i) => `${t.headers[i]}: ${c}`).join(' | '));
  if (t.more > 0) lines.push(`…and ${t.more} more in Monday.`);
  return lines.join('\n');
}

export function renderDigest(digest: Digest, logoUrl: string): RenderedEmail & { subject: string } {
  const link = digest.viewUrl
    ? { html: `<p><a href="${escapeHtml(digest.viewUrl)}">Open the view in Monday</a></p>`, text: `Open the view in Monday: ${digest.viewUrl}` }
    : { html: '', text: '' };
  const bodyHtml = [
    `<p>${escapeHtml(digest.intro)}</p>`,
    link.html,
    ...digest.sections.map((s) => `<h3 style="margin:24px 0 8px;">${escapeHtml(s.heading)}</h3>` +
      (s.note ? `<p style="margin:0 0 8px;">${escapeHtml(s.note)}</p>` : '') +
      (s.table ? tableHtml(s.table, digest.viewUrl) : `<p>${escapeHtml(s.empty)}</p>`)),
    '<p style="font-size:12px; color:#666666;">Sent by the report-digests integration, which replaced the Salesforce report subscription. Ask IT to change who gets it or when.</p>',
  ].join('\n');
  const bodyText = [
    digest.intro,
    link.text,
    ...digest.sections.map((s) => `\n${s.heading}\n${s.note ? `${s.note}\n` : ''}${s.table ? tableText(s.table) : s.empty}`),
  ].join('\n');
  return { subject: digest.subject, ...renderEmailLayout({ bodyHtml, bodyText, logoUrl }) };
}
