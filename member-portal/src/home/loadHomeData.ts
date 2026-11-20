// The portal header's loader, shared by every tab: membership fields per person, each person's
// totals for the member card (total given, hours volunteered), one card token per member, the
// discount list, and from Jan 1 to home.taxLetterUntil whether last year's tax letter exists.
// Tabs reuse what it read (`portal`): Benefits shows its discount list, Your giving its donations,
// Volunteering its shifts, so a tab never reads the same Monday data twice.
import type { AppDeps } from '../routes';
import type { PortalView } from '../types';
import type { PortalCard } from '../card/loadCardData';
import { cardFor } from '../doors/card';
import { loadLetterData } from '../letters/loadLetterData';
import { loadPortalData } from '../portal/loadPortalData';
import { statementExists } from '../orgs/loadOrgData';
import { parseAmount } from '../amounts';
import {
  cardEnabled,
  donationHistoryEnabled,
  eventsEnabled,
  lettersEnabled,
  orgAccessEnabled,
  volunteerHistoryEnabled,
} from '../config';
import type { OrgGrant } from '../orgs/grants';
import type { Locale } from '../i18n/locales';
import { errorText } from '../logSafe';
import { membershipEnded, pageState, personState, todayInLosAngeles } from './homeState';
import type { HomePerson, LetterSummary, PageState, PersonState } from './homeState';

export type TabKey = 'benefits' | 'giving' | 'events' | 'volunteering' | 'profile';

export interface TabLink {
  key: TabKey;
  href: string;
}

export interface PersonStats {
  // The donor's total as the giving tab shows it; null while the history gate is closed or the
  // amount doesn't parse.
  totalDonated: string | null;
  // null while volunteer history is off or its read failed.
  volunteerHours: number | null;
}

export interface HomeData {
  // In record (session) order; a person whose read failed is left out and counted below.
  // `ended`: the card greys out and reads "Ended MM/YYYY" (membershipEnded), whatever the page state.
  people: { person: HomePerson; state: PersonState; card: PortalCard | null; ended: boolean; stats: PersonStats }[];
  // null when the discount read failed.
  discountCount: number | null;
  page: PageState;
  unavailableCount: number;
  tabs: TabLink[];
  // The organizations the session manages ("You manage"), in grant order. `name` is null when the
  // name read failed. `statementReadyYear` is last year while its statement is ready, else null.
  orgs: { orgItemId: string; name: string | null; statementReadyYear: number | null }[];
  // What the header read, for the tabs to reuse.
  portal: PortalView;
}

type HomeDeps = Pick<AppDeps, 'monday' | 'config' | 'now' | 'cardTokenStore'>;

// "Jordan Rivera" → "Jordan".
function firstNameOf(name: string): string {
  return name.trim().split(/\s+/)[0] ?? '';
}

export function pluralKey<K extends string>(locale: Locale, count: number, one: K, other: K): K {
  return new Intl.PluralRules(locale).select(count) === 'one' ? one : other;
}

// One name read for every organization; a failure (or a missing item) leaves the name null.
async function loadOrgs(orgGrants: OrgGrant[], deps: HomeDeps): Promise<HomeData['orgs']> {
  if (orgGrants.length === 0 || !orgAccessEnabled(deps.config)) return [];
  let names = new Map<string, string>();
  try {
    const rows = await deps.monday.getDonorNames(orgGrants.map((g) => g.orgItemId));
    names = new Map(rows.map((r) => [r.id, r.name]));
  } catch (err) {
    console.error(`member-portal home organization names failed: ${errorText(err)}`);
  }
  // The ready line: last year's statement exists, until home.taxLetterUntil. One read per
  // organization; a failure costs that organization its ready line only.
  const today = todayInLosAngeles(deps.now());
  const lastYear = Number(today.slice(0, 4)) - 1;
  const inWindow = today.slice(5) <= deps.config.home.taxLetterUntil;
  const readyYears = await Promise.all(
    orgGrants.map(async (g) => {
      if (!inWindow) return null;
      try {
        return (await statementExists(g.orgItemId, lastYear, deps)) ? lastYear : null;
      } catch (err) {
        console.error(`member-portal home organization statement read failed for "${g.orgItemId}": ${errorText(err)}`);
        return null;
      }
    })
  );
  return orgGrants.map((g, i) => ({ orgItemId: g.orgItemId, name: names.get(g.orgItemId) ?? null, statementReadyYear: readyYears[i]! }));
}

const EMPTY_PORTAL: PortalView = { donors: [], unavailableDonorCount: 0, discounts: null, volunteerHistory: null, donationHistoryEnabled: false };

export async function loadHomeData(donorItemIds: string[], deps: HomeDeps, locale: Locale, orgGrants: OrgGrant[] = []): Promise<HomeData> {
  const now = deps.now();
  const today = todayInLosAngeles(now);
  const cfg = deps.config.home;
  const lastYear = Number(today.slice(0, 4)) - 1;
  // Same rule as the letters list: the letter exists once the sign-off gate is open.
  const letterWindow = today.slice(5) <= cfg.taxLetterUntil && lettersEnabled(deps.config);

  const orgsLeg = loadOrgs(orgGrants, deps);

  // A failed letter costs that person the tax-letter state, nothing else.
  const lettersLeg: Promise<(LetterSummary | null)[]> = Promise.all(
    donorItemIds.map((id) =>
      letterWindow
        ? loadLetterData(id, lastYear, deps.monday, deps.config.taxLetter, now).then(
            (l) => (l === null ? null : { year: l.year, giftCount: l.gifts.length, totalFormatted: l.totalFormatted }),
            (err: unknown) => {
              console.error(`member-portal home letter read failed for donor "${id}": ${errorText(err)}`);
              return null;
            }
          )
        : Promise.resolve(null)
    )
  );

  // Membership, donations (behind the history gate), volunteer shifts and the discount list.
  // Throws only when no one loads (the route's error page). A work-only session reads nothing.
  const portal =
    donorItemIds.length === 0
      ? EMPTY_PORTAL
      : await loadPortalData(
          donorItemIds,
          deps.monday,
          { enabled: volunteerHistoryEnabled(deps.config), completedStatuses: deps.config.volunteerHistory.completedStatuses },
          donationHistoryEnabled(deps.config, now)
        );
  const letters = await lettersLeg;
  const letterFor = new Map(donorItemIds.map((id, i) => [id, letters[i] ?? null]));

  const withCards = cardEnabled(deps.config);
  const people = await Promise.all(
    portal.donors.map(async (donor) => {
      const person: HomePerson = {
        id: donor.id,
        firstName: firstNameOf(donor.name),
        status: donor.membershipStatus,
        tier: donor.membershipTier,
        until: donor.membershipExpiry,
        since: donor.memberSince ?? '',
        memberType: donor.memberType ?? '',
        letter: letterFor.get(donor.id) ?? null,
      };
      const state = personState(person, today, cfg);
      // Someone who was never a member gets a "Not a member yet" panel, so no card token. Nor does
      // anyone with a blank Membership Status: the card would show a member number with no status.
      const noCard = (state.kind === 'renew' && state.reason === 'never') || donor.membershipStatus.trim() === '';
      const card = withCards && !noCard ? await cardFor(donor, deps) : null;
      const stats: PersonStats = {
        totalDonated: portal.donationHistoryEnabled && parseAmount(donor.totalDonated) !== null ? donor.totalDonated : null,
        volunteerHours: portal.volunteerHistory?.[donor.id]?.totalHours ?? null,
      };
      return { person, state, card, ended: membershipEnded(person, today), stats };
    })
  );

  const orgs = await orgsLeg;
  return {
    people,
    discountCount: portal.discounts === null ? null : portal.discounts.length,
    page: pageState(people),
    unavailableCount: portal.unavailableDonorCount ?? 0,
    // A session with no people has no tabs: its page is the organizations alone.
    tabs: people.length === 0 ? [] : tabLinks(deps, locale),
    orgs,
    portal,
  };
}

// Benefits, Your giving and Profile always have something (the discount list, matching gifts, the
// change form); Events and Volunteering only when their feature or a Get involved link is set.
function tabLinks(deps: HomeDeps, locale: Locale): TabLink[] {
  const config = deps.config;
  const href = (path: string) => `/${locale}/portal${path}`;
  const links = config.getInvolved.links;
  const tabs: TabLink[] = [
    { key: 'benefits', href: href('') },
    { key: 'giving', href: href('/giving') },
  ];
  if (eventsEnabled(config) || links.some((l) => l.category !== 'volunteer')) {
    tabs.push({ key: 'events', href: href('/events') });
  }
  if (volunteerHistoryEnabled(config) || links.some((l) => l.category === 'volunteer')) {
    tabs.push({ key: 'volunteering', href: href('/volunteering') });
  }
  tabs.push({ key: 'profile', href: href('/info') });
  return tabs;
}
