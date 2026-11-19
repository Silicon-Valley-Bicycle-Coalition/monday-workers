// The card-first home page: where each person stands, the one thing worth doing next (at most one
// gold button), their card(s), and the doors. State comes from homeState.ts; this only renders.
import type { Locale } from '../i18n/locales';
import { t, type TranslationKey } from '../i18n/t';
import { escapeHtml, someRecordsUnavailableNote } from '../views';
import { endedMonth, memberCardWidget } from '../doors/card';
import type { PersonState } from './homeState';
import { pluralKey, type DoorLink, type HomeData } from './loadHomeData';

const DOOR_TITLES: Record<DoorLink['key'], TranslationKey> = {
  card: 'home.doorCard',
  giving: 'home.doorGiving',
  letters: 'home.doorLetters',
  activity: 'home.doorActivity',
  info: 'home.doorInfo',
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

function statusBlock(data: HomeData, locale: Locale, renewUrl: string): StatusBlock {
  // The session covers everyone, loaded or not: with one record missing, the viewer may be the
  // person who failed to load, so the copy still names whose state it is and the renew button
  // still can't promise whose membership a gift renews.
  const household = data.people.length + data.unavailableCount > 1;
  const holders = data.people.filter((e) => data.page.personIds.includes(e.person.id));
  const first = holders[0];
  const lettersHref = `/${locale}/portal/letters`;
  const cardHref = `/${locale}/portal/card`;

  if (first === undefined || data.page.kind === 'default') {
    // Name the card(s) only when one shows (a card token can fail, or the card feature be off).
    const cardShown = data.people.some((e) => e.card !== null);
    const key = !cardShown ? 'home.defaultHeadlineNoCard' : household ? 'home.defaultHeadlineMany' : 'home.defaultHeadline';
    return { headline: t(locale, key), sub: null, button: null, note: null };
  }

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

function link(action: Action, className: string): string {
  const rel = action.external ? ' rel="noopener noreferrer"' : '';
  return `<a class="${className}" href="${escapeHtml(action.href)}"${rel}>${escapeHtml(action.text)}</a>`;
}

// A person whose state differs from the page's keeps a plain link of their own, so one person's
// state never hides behind another's.
function personAction(state: PersonState, locale: Locale, renewUrl: string): Action | null {
  switch (state.kind) {
    case 'taxLetter':
      return { href: `/${locale}/portal/letters`, text: t(locale, 'home.cardTaxLetterLink'), external: false };
    case 'renew':
      return { href: renewUrl, text: t(locale, state.reason === 'never' ? 'home.cardJoinLink' : 'home.cardRenewLink'), external: true };
    case 'newMember':
      return { href: `/${locale}/portal/card`, text: t(locale, 'home.cardDiscountsLink'), external: false };
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
    body = memberCardWidget(card, locale, { regenerate: false, lapsed: ended ? { ended: endedMonth(person.until) } : null });
  }
  const action = state.kind === data.page.kind ? null : personAction(state, locale, renewUrl);
  const actionHtml = action === null ? '' : `<p>${link(action, 'home-person-action')}</p>`;
  return `<div class="home-person">${body}${actionHtml}</div>`;
}

// The hidden ": " keeps a screen reader from running the title into the hint.
function doorList(doors: DoorLink[], locale: Locale): string {
  if (doors.length === 0) return '';
  const items = doors
    .map(
      (door) =>
        `<a class="home-door" href="${escapeHtml(door.href)}"><span class="home-door-title">${escapeHtml(t(locale, DOOR_TITLES[door.key]))}<span class="visually-hidden">: </span></span><span class="home-door-hint">${escapeHtml(door.hint)}</span></a>`
    )
    .join('');
  return `<nav class="home-doors" aria-label="${escapeHtml(t(locale, 'home.doorsLabel'))}">${items}</nav>`;
}

// "You manage": one plain link per organization, no gold button. The hidden ": " keeps a screen
// reader from running the name into the statement line.
function orgSection(orgs: HomeData['orgs'], locale: Locale): string {
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

export function homeView(data: HomeData, locale: Locale, renewUrl: string): string {
  // Work-only session: no greeting, headline, cards or doors, just the organizations.
  if (data.people.length === 0 && data.orgs.length > 0) {
    return `<div class="home">${orgSection(data.orgs, locale)}</div>`;
  }
  const names = data.people.map((e) => e.person.firstName).filter((n) => n !== '');
  const greeting =
    names.length === 0
      ? t(locale, 'home.greetingNoName')
      : t(locale, data.page.kind === 'newMember' ? 'home.greetingWelcome' : 'home.greeting', { names: joinNames(names, locale) });
  const status = statusBlock(data, locale, renewUrl);
  return `
    <div class="home">
      <div class="home-status">
        <p class="home-greeting">${escapeHtml(greeting)}</p>
        <h1 class="home-headline">${escapeHtml(status.headline)}</h1>
        ${status.sub === null ? '' : `<p class="home-sub">${escapeHtml(status.sub)}</p>`}
        ${status.button === null ? '' : link(status.button, 'cta-button home-action')}
        ${status.note === null ? '' : `<p class="home-note">${escapeHtml(status.note)}</p>`}
      </div>
      <div class="home-people">
        ${data.people.map((entry) => personBlock(entry, data, locale, renewUrl)).join('')}
      </div>
      ${data.unavailableCount > 0 ? `<div class="home-unavailable">${someRecordsUnavailableNote(data.unavailableCount, locale)}</div>` : ''}
      ${doorList(data.doors, locale)}
      ${orgSection(data.orgs, locale)}
    </div>
  `;
}
