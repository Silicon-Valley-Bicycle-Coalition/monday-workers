import { dateCol } from './fields.js';

export interface MembershipRow {
  Id: string; Contact__c: string; Opportunity__c: string; Type__c: string | null;
  Start_Date__c: string | null; WEC_End_Date_Manual__c: string | null;
}

export interface MemberSummary {
  status: 'Active' | 'Lapsed'; tier: 'Lifetime' | 'Member';
  sinceISO: string | null; untilISO: string | null;
}

export function deriveMembers(terms: MembershipRow[], cutoverISO: string): Map<string, MemberSummary> {
  const byContact = new Map<string, MembershipRow[]>();
  for (const t of terms) {
    if (!byContact.has(t.Contact__c)) byContact.set(t.Contact__c, []);
    byContact.get(t.Contact__c)!.push(t);
  }
  const out = new Map<string, MemberSummary>();
  for (const [contactId, rows] of byContact) {
    const lifetime = rows.some((r) => r.Type__c === 'Lifetime');
    const ends = rows.map((r) => r.WEC_End_Date_Manual__c).filter((d): d is string => !!d).sort();
    const starts = rows.map((r) => r.Start_Date__c).filter((d): d is string => !!d).sort();
    const latestEnd = ends.at(-1) ?? null;
    out.set(contactId, {
      status: lifetime || (latestEnd !== null && latestEnd >= cutoverISO) ? 'Active' : 'Lapsed',
      tier: lifetime ? 'Lifetime' : 'Member',
      sinceISO: starts[0] ?? null,
      untilISO: lifetime ? null : latestEnd,
    });
  }
  return out;
}

export function termColumnsByOpportunity(terms: MembershipRow[]): {
  columns: Map<string, Record<string, unknown>>; ambiguous: string[];
} {
  const grouped = new Map<string, MembershipRow[]>();
  for (const t of terms) {
    if (!grouped.has(t.Opportunity__c)) grouped.set(t.Opportunity__c, []);
    grouped.get(t.Opportunity__c)!.push(t);
  }
  const columns = new Map<string, Record<string, unknown>>();
  const ambiguous: string[] = [];
  for (const [oppId, rows] of grouped) {
    // Multi-term links are real in this org: joint/household memberships share one payment
    // (identical term rows for two contacts), and historical imports attached thousands of
    // terms to placeholder Opportunities. Write term columns only when every term agrees;
    // never pick sides silently.
    const t = rows[0]!;
    const agree = rows.every((r) => r.Start_Date__c === t.Start_Date__c &&
      r.WEC_End_Date_Manual__c === t.WEC_End_Date_Manual__c && r.Type__c === t.Type__c);
    if (!agree) { ambiguous.push(`Opportunity ${oppId} has ${rows.length} disagreeing membership terms`); continue; }
    columns.set(oppId, {
      'Term Start': dateCol(t.Start_Date__c), 'Term End': dateCol(t.WEC_End_Date_Manual__c),
      'Membership Type': t.Type__c ?? '',
    });
  }
  return { columns, ambiguous };
}
