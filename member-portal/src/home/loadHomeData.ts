// The home page's slim loader: membership fields per person (no donations), one card token per
// member, the discount list for its shop count, and from Jan 1 to home.taxLetterUntil whether last
// year's tax letter exists. No events, volunteer shifts or donation history: those are door reads.
import type { AppDeps } from '../routes';
import type { MemberPortalData } from '../types';
import type { PortalCard } from '../card/loadCardData';
import { cardFor } from '../doors/card';
import { loadLetterData } from '../letters/loadLetterData';
import { cardEnabled, eventsEnabled, lettersEnabled, volunteerHistoryEnabled } from '../config';
import type { Locale } from '../i18n/locales';
import { t } from '../i18n/t';
import { errorText } from '../logSafe';
import { membershipEnded, pageState, personState, todayInLosAngeles } from './homeState';
import type { HomePerson, LetterSummary, PageState, PersonState } from './homeState';

export interface DoorLink {
  key: 'card' | 'giving' | 'letters' | 'activity' | 'info';
  href: string;
  // Already translated.
  hint: string;
}

export interface HomeData {
  // In record (session) order; a person whose read failed is left out and counted below.
  // `ended`: the card greys out and reads "Ended MM/YYYY" (membershipEnded), whatever the page state.
  people: { person: HomePerson; state: PersonState; card: PortalCard | null; ended: boolean }[];
  // null when the discount read failed.
  discountCount: number | null;
  page: PageState;
  unavailableCount: number;
  doors: DoorLink[];
}

type HomeDeps = Pick<AppDeps, 'monday' | 'config' | 'now' | 'cardTokenStore'>;

// "Jordan Rivera" → "Jordan".
function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}

export function pluralKey<K extends string>(locale: Locale, count: number, one: K, other: K): K {
  return new Intl.PluralRules(locale).select(count) === 'one' ? one : other;
}

export async function loadHomeData(donorItemIds: string[], deps: HomeDeps, locale: Locale): Promise<HomeData> {
  const now = deps.now();
  const today = todayInLosAngeles(now);
  const cfg = deps.config.home;
  const lastYear = Number(today.slice(0, 4)) - 1;
  // Same rule as the letters page: the letter exists once the sign-off gate is open.
  const letterWindow = today.slice(5) <= cfg.taxLetterUntil && lettersEnabled(deps.config);

  const discountLeg = deps.monday.getDiscountOrganizations().then(
    (list) => list.length,
    (err: unknown) => {
      console.error(`member-portal home discount count failed: ${errorText(err)}`);
      return null;
    }
  );

  // Each person's membership read and (in the window) letter read run side by side. A failed
  // letter costs that person the tax-letter state, nothing else.
  const legs = donorItemIds.map((id) => {
    const donor = deps.monday.getMemberPortalData(id, { includeDonations: false });
    const letter: Promise<LetterSummary | null> = letterWindow
      ? loadLetterData(id, lastYear, deps.monday, deps.config.taxLetter, now).then(
          (l) => (l === null ? null : { year: l.year, giftCount: l.gifts.length, totalFormatted: l.totalFormatted }),
          (err: unknown) => {
            console.error(`member-portal home letter read failed for donor "${id}": ${errorText(err)}`);
            return null;
          }
        )
      : Promise.resolve(null);
    return Promise.all([donor, letter]);
  });
  const results = await Promise.allSettled(legs);

  const loaded: { donor: MemberPortalData; letter: LetterSummary | null }[] = [];
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      loaded.push({ donor: result.value[0], letter: result.value[1] });
    } else {
      console.error(`member-portal home load failed for donor "${donorItemIds[index]}": ${errorText(result.reason)}`);
    }
  });
  // Nothing to show at all: the route's error page, as the dashboard did.
  if (loaded.length === 0 && results.length > 0) throw (results[0] as PromiseRejectedResult).reason;

  const withCards = cardEnabled(deps.config);
  const people = await Promise.all(
    loaded.map(async ({ donor, letter }) => {
      const person: HomePerson = {
        id: donor.id,
        firstName: firstNameOf(donor.name),
        status: donor.membershipStatus,
        tier: donor.membershipTier,
        until: donor.membershipExpiry,
        since: donor.memberSince ?? '',
        memberType: donor.memberType ?? '',
        letter,
      };
      const state = personState(person, today, cfg);
      // Someone who was never a member gets a "Not a member yet" panel, so no card token.
      const never = state.kind === 'renew' && state.reason === 'never';
      const card = withCards && !never ? await cardFor(donor, deps) : null;
      return { person, state, card, ended: membershipEnded(person, today) };
    })
  );

  const discountCount = await discountLeg;
  const page = pageState(people);
  return {
    people,
    discountCount,
    page,
    unavailableCount: results.length - loaded.length,
    doors: doorLinks(people, discountCount, Number(today.slice(0, 4)), deps, locale),
  };
}

function doorLinks(people: HomeData['people'], discountCount: number | null, year: number, deps: HomeDeps, locale: Locale): DoorLink[] {
  const config = deps.config;
  const href = (path: string) => `/${locale}/portal/${path}`;
  const doors: DoorLink[] = [];

  // The discount list and the card: the list has no gate, so this door is always there.
  const cardHint =
    discountCount === null
      ? t(locale, 'home.doorHintCardNoCount')
      : t(locale, pluralKey(locale, discountCount, 'home.doorHintCardOne', 'home.doorHintCard'), { count: String(discountCount) });
  doors.push({ key: 'card', href: href('card'), hint: cardHint });

  // Matching gifts always renders, so giving always has something.
  doors.push({ key: 'giving', href: href('giving'), hint: t(locale, 'home.doorHintGiving') });

  if (lettersEnabled(config)) {
    const ready = people.filter((e) => e.person.letter !== null);
    const hint =
      ready.length === 0
        ? t(locale, 'home.doorHintLettersLater', { year: String(year) })
        : t(locale, ready.length === 1 ? 'home.doorHintLettersReady' : 'home.doorHintLettersReadyMany', { year: String(ready[0]!.person.letter!.year) });
    doors.push({ key: 'letters', href: href('letters'), hint });
  }

  if (eventsEnabled(config) || volunteerHistoryEnabled(config) || config.getInvolved.links.length > 0) {
    doors.push({ key: 'activity', href: href('activity'), hint: t(locale, 'home.doorHintActivity') });
  }

  // Every record has email addresses and a language, so this door always has content.
  doors.push({ key: 'info', href: href('info'), hint: t(locale, 'home.doorHintInfo') });
  return doors;
}
