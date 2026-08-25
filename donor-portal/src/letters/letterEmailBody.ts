import { escapeHtml } from '../views';

export interface LetterEmailBodyParams {
  donorName: string;
  year: number;
  loginUrl: string;
}

export interface RenderedLetterEmailBody {
  text: string;
  html: string;
}

// Renders the staff-edited letter-ready email template (the Letter Settings board's long-text
// column) into text and HTML parts. The template is treated strictly as plain text: staff-pasted
// markup is escaped, not interpreted, so the settings board can never become an HTML-injection
// vector into donor email. Supported placeholders: {{donorName}}, {{year}}, {{loginUrl}} —
// anything else passes through literally.
export function renderLetterEmailBody(template: string, params: LetterEmailBodyParams): RenderedLetterEmailBody {
  const text = template
    .replaceAll('{{donorName}}', params.donorName)
    .replaceAll('{{year}}', String(params.year))
    .replaceAll('{{loginUrl}}', params.loginUrl);

  // Escape the template first, then substitute — so placeholder values (and the anchor markup
  // around {{loginUrl}}) are the only things that can differ from the escaped template text.
  const htmlUrl = escapeHtml(params.loginUrl);
  const substituted = escapeHtml(template)
    .replaceAll('{{donorName}}', escapeHtml(params.donorName))
    .replaceAll('{{year}}', String(params.year))
    .replaceAll('{{loginUrl}}', `<a href="${htmlUrl}">${htmlUrl}</a>`);
  const html = substituted
    .split(/\n{2,}/)
    .map((block) => `<p>${block.replaceAll('\n', '<br>')}</p>`)
    .join('');

  return { text, html };
}
