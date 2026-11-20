import { backToPortalLink, escapeHtml } from '../views';
import { formatShortDate } from '../dates';
import { t } from '../i18n/t';
import type { Locale } from '../i18n/locales';
import type { DonorPledges, PledgeWithProgress } from './loadPledgeData';

function pledgeRow(pledge: PledgeWithProgress): string {
  const progress = pledge.percentComplete === null ? '—' : `${pledge.percentComplete}%`;
  return `
    <tr>
      <td>${escapeHtml(pledge.name)}</td>
      <td>${escapeHtml(pledge.pledged)}</td>
      <td>${escapeHtml(pledge.fulfilled)}</td>
      <td>${escapeHtml(progress)}</td>
      <td>${escapeHtml(pledge.status)}</td>
      <td>${escapeHtml(formatShortDate(pledge.dueDate))}</td>
    </tr>
  `;
}

function donorPledgeSection(section: DonorPledges, locale: Locale): string {
  if (section.pledges.length === 0) {
    return `
      <section>
        <h2>${escapeHtml(section.donorName)}</h2>
        <p>${escapeHtml(t(locale, 'pledges.noneYet', { name: section.donorName }))}</p>
      </section>
    `;
  }
  return `
    <section>
      <h2>${escapeHtml(section.donorName)}</h2>
      <table>
        <thead>
          <tr>
            <th>${escapeHtml(t(locale, 'pledges.tablePledge'))}</th>
            <th>${escapeHtml(t(locale, 'pledges.tablePledged'))}</th>
            <th>${escapeHtml(t(locale, 'pledges.tableFulfilled'))}</th>
            <th>${escapeHtml(t(locale, 'pledges.tableProgress'))}</th>
            <th>${escapeHtml(t(locale, 'pledges.tableStatus'))}</th>
            <th>${escapeHtml(t(locale, 'pledges.tableDue'))}</th>
          </tr>
        </thead>
        <tbody>
          ${section.pledges.map(pledgeRow).join('')}
        </tbody>
      </table>
    </section>
  `;
}

export function pledgesView(sections: DonorPledges[], locale: Locale): string {
  return `
    <h1>${escapeHtml(t(locale, 'pledges.heading'))}</h1>
    <p>${escapeHtml(t(locale, 'pledges.intro'))}</p>
    ${sections.map((s) => donorPledgeSection(s, locale)).join('')}
    ${backToPortalLink(locale)}
  `;
}

export function pledgesUnavailableView(locale: Locale): string {
  return `
    <h1>${escapeHtml(t(locale, 'pledges.heading'))}</h1>
    <p>${escapeHtml(t(locale, 'pledges.unavailable'))}</p>
    ${backToPortalLink(locale)}
  `;
}
