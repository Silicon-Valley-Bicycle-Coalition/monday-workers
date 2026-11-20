// The portal frame every tab shares: where each person stands and the one thing worth doing next
// (at most one gold button), each person's member card with their totals, then the tab bar and the
// active tab's panel. State comes from homeState.ts; this only renders. No JavaScript: each tab is
// its own page, linked from the bar with aria-current on the active one.
import type { Locale } from '../i18n/locales';
import { t, type TranslationKey } from '../i18n/t';
import { escapeHtml, someRecordsUnavailableNote } from '../views';
import { formatUsdText } from '../money';
import { PORTAL_TABS_JS_ASSET } from '../assets/static';
import { endedMonth, memberCardWidget } from '../doors/card';
import type { PersonState } from './homeState';
import { pluralKey, type HomeData, type PersonStats, type TabKey, type TabLink } from './loadHomeData';

export const TAB_TITLES: Record<TabKey, TranslationKey> = {
  benefits: 'tabs.benefits',
  giving: 'home.doorGiving',
  events: 'events.tabLabel',
  volunteering: 'tabs.volunteering',
  profile: 'tabs.profile',
};

interface Action {
  href: string;
  text: string;
  external: boolean;
}

interface StatusBlock {
  headline: string;
  sub: string | null;
  button: Action | null;
  note: string | null;
}

// First names joined the way the locale joins a list ("Jordan and Sam", "Jordan y Sam").
function joinNames(names: string[], locale: Locale): string {
  try {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(names);
  } catch {
    return names.join(', ');
  }
}

function utcDate(iso: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const date = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

// "Dec 1" for a date within the renewal window; with the year for an end that may be long past.
function formatDate(iso: string, locale: Locale, withYear: boolean): string {
  const date = utcDate(iso);
  if (date === null) return iso;
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), timeZone: 'UTC' }).format(date);
}

function shopLine(count: number | null, locale: Locale): string {
  if (count === null) return t(locale, 'home.newMemberSubNoCount');
  return t(locale, pluralKey(locale, count, 'home.newMemberSubOne', 'home.newMemberSub'), { count: String(count) });
}

// The letter's acknowledged gifts and their total, as the letter shows them. null when it
// acknowledges none (only separately listed gifts, such as a donor-advised fund's): that letter
// shows no total, so "0 gifts · $0.00" would misread it.
function letterLine(letter: { year: number; giftCount: number; totalFormatted: string }, locale: Locale): string | null {
  if (letter.giftCount === 0) return null;
  return t(locale, pluralKey(locale, letter.giftCount, 'home.letterSummaryOne', 'home.letterSummaryOther'), {
    count: String(letter.giftCount),
    total: letter.totalFormatted,
    year: String(letter.year),
  });
}

function renewHeadline(state: Extract<PersonState, { kind: 'renew' }>, name: string | null, locale: Locale): string {
  if (state.reason === 'never') {
    return name === null ? t(locale, 'home.renewNeverHeadline') : t(locale, 'home.renewNeverHeadlineNamed', { name });
  }
  if (state.reason === 'due' && state.date !== null) {
    const date = formatDate(state.date, locale, false);
    return name === null ? t(locale, 'home.renewDueHeadline', { date }) : t(locale, 'home.renewDueHeadlineNamed', { name, date });
  }
  if (state.date !== null) {
    const date = formatDate(state.date, locale, true);
    return name === null ? t(locale, 'home.renewLapsedHeadline', { date }) : t(locale, 'home.renewLapsedHeadlineNamed', { name, date });
  }
  return name === null ? t(locale, 'home.renewLapsedHeadlineNoDate') : t(locale, 'home.renewLapsedHeadlineNamedNoDate', { name });
}

// null in the default state: with nothing to act on, the header is just the cards and stats.
function statusBlock(data: HomeData, locale: Locale, renewUrl: string): StatusBlock | null {
  // The session covers everyone, loaded or not: with one record missing, the viewer may be the
  // person who failed to load, so the copy still names whose state it is and the renew button
  // still can't promise whose membership a gift renews.
  const household = data.people.length + data.unavailableCount > 1;
  const holders = data.people.filter((e) => data.page.personIds.includes(e.person.id));
  const first = holders[0];
  const lettersHref = lettersLink(locale);
  const cardHref = discountsLink(locale);

  if (first === undefined || data.page.kind === 'default') return null;

  if (first.state.kind === 'taxLetter') {
    const letter = first.state.letter;
    const year = String(letter.year);
    if (holders.length > 1) {
      return {
        headline: t(locale, 'home.taxLettersHeadline', { year }),
        sub: t(locale, 'home.taxLettersSub', { names: joinNames(holders.map((e) => e.person.firstName), locale) }),
        button: { href: lettersHref, text: t(locale, 'home.taxLettersButton'), external: false },
        note: null,
      };
    }
    const name = first.person.firstName;
    return {
      headline: household ? t(locale, 'home.taxLetterHeadlineNamed', { name, year }) : t(locale, 'home.taxLetterHeadline', { year }),
      sub: letterLine(letter, locale),
      button: {
        href: lettersHref,
        text: household ? t(locale, 'home.taxLetterButtonNamed', { name }) : t(locale, 'home.taxLetterButton'),
        external: false,
      },
      note: null,
    };
  }

  if (first.state.kind === 'renew') {
    if (!household) {
      const never = first.state.reason === 'never';
      return {
        headline: renewHeadline(first.state, null, locale),
        sub: t(locale, never ? 'home.joinSub' : 'home.renewSub'),
        button: { href: renewUrl, text: t(locale, never ? 'home.joinButton' : 'home.renewButton'), external: true },
        note: null,
      };
    }
    // A Funraise gift renews whoever it matches the payer to, so the button can't promise to renew
    // a particular person (spec, decided 2026-11-18). When no one it's for has ever been a member,
    // the same button and note speak of joining instead.
    const allNever = holders.every((e) => e.state.kind === 'renew' && e.state.reason === 'never');
    const names = joinNames(holders.map((e) => e.person.firstName), locale);
    const headline =
      holders.length === 1
        ? renewHeadline(first.state, first.person.firstName, locale)
        : t(locale, allNever ? 'home.joinManyHeadline' : 'home.renewManyHeadline', { names });
    return {
      headline,
      sub: t(locale, allNever ? 'home.joinSub' : 'home.renewSub'),
      button: { href: renewUrl, text: t(locale, allNever ? 'home.joinAny' : 'home.renewAny'), external: true },
      note: t(locale, allNever ? 'home.joinEachNote' : 'home.renewEachNote'),
    };
  }

  // newMember
  return {
    // One key per count, so a language whose verb agrees with its subject ("se unió" / "se
    // unieron") reads right for one name or several.
    headline: household
      ? t(locale, holders.length > 1 ? 'home.newMemberHeadlineNamedMany' : 'home.newMemberHeadlineNamed', {
          names: joinNames(holders.map((e) => e.person.firstName), locale),
        })
      : t(locale, 'home.newMemberHeadline'),
    sub: shopLine(data.discountCount, locale),
    button: { href: cardHref, text: t(locale, 'home.newMemberButton'), external: false },
    note: null,
  };
}

// Tax letters live on the giving tab; discounts on Benefits.
export const lettersLink = (locale: Locale): string => `/${locale}/portal/giving#tax-letters`;
export const discountsLink = (locale: Locale): string => `/${locale}/portal#discounts`;

function link(action: Action, className: string): string {
  const rel = action.external ? ' rel="noopener noreferrer"' : '';
  return `<a class="${className}" href="${escapeHtml(action.href)}"${rel}>${escapeHtml(action.text)}</a>`;
}

// A person whose state differs from the page's keeps a plain link of their own, so one person's
// state never hides behind another's.
function personAction(state: PersonState, locale: Locale, renewUrl: string): Action | null {
  switch (state.kind) {
    case 'taxLetter':
      return { href: lettersLink(locale), text: t(locale, 'home.cardTaxLetterLink'), external: false };
    case 'renew':
      return { href: renewUrl, text: t(locale, state.reason === 'never' ? 'home.cardJoinLink' : 'home.cardRenewLink'), external: true };
    case 'newMember':
      return { href: discountsLink(locale), text: t(locale, 'home.cardDiscountsLink'), external: false };
    default:
      return null;
  }
}

function personBlock(entry: HomeData['people'][number], data: HomeData, locale: Locale, renewUrl: string): string {
  const { person, state, card, ended } = entry;
  const never = state.kind === 'renew' && state.reason === 'never';
  let body = '';
  if (never) {
    body = `<div class="home-not-member"><p class="home-not-member-name">${escapeHtml(person.firstName)}</p><p>${escapeHtml(t(locale, 'home.notMember'))}</p></div>`;
  } else if (card !== null) {
    body = memberCardWidget(card, locale, { lapsed: ended ? { ended: endedMonth(person.until) } : null });
  }
  const action = state.kind === data.page.kind ? null : personAction(state, locale, renewUrl);
  const actionHtml = action === null ? '' : `<p>${link(action, 'home-person-action')}</p>`;
  return `<div class="home-person">${body}${statsList(entry.stats, person.since, locale)}${actionHtml}</div>`;
}

// The member's totals beside their card. A total that isn't available (history gate closed,
// volunteer history off or failed, no Member Since) is left out rather than shown as zero.
function statsList(stats: PersonStats, since: string, locale: Locale): string {
  const rows: [TranslationKey, string][] = [];
  if (stats.totalDonated !== null) rows.push(['stats.totalGiven', formatUsdText(stats.totalDonated)]);
  if (stats.volunteerHours !== null) rows.push(['stats.hoursVolunteered', new Intl.NumberFormat(locale).format(stats.volunteerHours)]);
  const sinceYear = /^\d{4}-\d{2}-\d{2}$/.test(since.trim()) ? since.trim().slice(0, 4) : null;
  if (sinceYear !== null) rows.push(['stats.memberSince', sinceYear]);
  if (rows.length === 0) return '';
  const items = rows
    .map(([label, value]) => `<div class="member-stat"><dt>${escapeHtml(t(locale, label))}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join('');
  return `<dl class="member-stats">${items}</dl>`;
}

const TABS_ID = 'tabs';

function tabBar(tabs: TabLink[], active: TabKey, locale: Locale): string {
  if (tabs.length === 0) return '';
  const items = tabs
    .map((tab) => {
      const current = tab.key === active ? ' aria-current="page"' : '';
      // Each tab is its own page. portalTabs.ts swaps the panel in place so the page never moves;
      // without it, the fragment at least lands the next page on the tab bar.
      return `<a class="portal-tab" href="${escapeHtml(`${tab.href}#${TABS_ID}`)}"${current}>${escapeHtml(t(locale, TAB_TITLES[tab.key]))}</a>`;
    })
    .join('');
  return `<nav class="portal-tabs" id="${TABS_ID}" aria-label="${escapeHtml(t(locale, 'home.doorsLabel'))}">${items}</nav><script src="${PORTAL_TABS_JS_ASSET.path}" defer></script>`;
}

// "You manage": one plain link per organization, no gold button. The hidden ": " keeps a screen
// reader from running the name into the statement line.
export function orgSection(orgs: HomeData['orgs'], locale: Locale): string {
  if (orgs.length === 0) return '';
  const rows = orgs
    .map((org) => {
      const name = org.name !== null && org.name.trim() !== '' ? org.name : t(locale, 'orgs.unnamed');
      const ready =
        org.statementReadyYear === null
          ? ''
          : `<span class="home-door-hint">${escapeHtml(t(locale, 'orgs.statementReady', { year: String(org.statementReadyYear) }))}</span>`;
      const href = `/${locale}/portal/org/${encodeURIComponent(org.orgItemId)}`;
      const hidden = ready === '' ? '' : '<span class="visually-hidden">: </span>';
      return `<a class="home-door" href="${escapeHtml(href)}"><span class="home-door-title">${escapeHtml(name)}${hidden}</span>${ready}</a>`;
    })
    .join('');
  return `<section class="home-orgs" aria-labelledby="home-orgs-title"><h2 id="home-orgs-title" class="home-orgs-title">${escapeHtml(t(locale, 'orgs.sectionTitle'))}</h2><div class="home-doors">${rows}</div></section>`;
}

// `panel` is the active tab's content, rendered by that tab's own view (src/doors/).
export function portalView(data: HomeData, active: TabKey, panel: string, locale: Locale, renewUrl: string): string {
  // Work-only session: no headline, cards or tabs, just the organizations.
  if (data.people.length === 0 && data.orgs.length > 0) {
    return `<div class="home">${orgSection(data.orgs, locale)}</div>`;
  }
  // Neither people nor organizations (e.g. the org gate was turned off mid-session): a short note
  // instead of an empty layout; the shared header still carries sign-out.
  if (data.people.length === 0) {
    return `<div class="home"><p class="home-empty">${escapeHtml(t(locale, 'orgs.nothingToShow'))}</p></div>`;
  }
  const status = statusBlock(data, locale, renewUrl);
  const statusHtml =
    status === null
      ? ''
      : `<div class="home-status">
          <p class="home-headline">${escapeHtml(status.headline)}</p>
          ${status.sub === null ? '' : `<p class="home-sub">${escapeHtml(status.sub)}</p>`}
          ${status.button === null ? '' : link(status.button, 'cta-button home-action')}
          ${status.note === null ? '' : `<p class="home-note">${escapeHtml(status.note)}</p>`}
        </div>`;
  return `
    <div class="home">
      <div class="home-header">
        <div class="home-people">
          ${data.people.map((entry) => personBlock(entry, data, locale, renewUrl)).join('')}
        </div>
        ${statusHtml}
      </div>
      ${data.unavailableCount > 0 ? `<div class="home-unavailable">${someRecordsUnavailableNote(data.unavailableCount, locale)}</div>` : ''}
      ${tabBar(data.tabs, active, locale)}
      <div class="portal-panel">${panel}</div>
    </div>
  `;
}
