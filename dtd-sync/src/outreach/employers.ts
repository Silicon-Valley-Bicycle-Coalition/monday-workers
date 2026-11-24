import type { MatchingEmployer, OutreachConfig } from '../config';
import { normalizeEmployerName } from '../employerName';

export type PromptVariant = { kind: 'known'; employer: MatchingEmployer } | { kind: 'ask' };

/**
 * Which email a donor gets, or null for none: `known` when their employer is a known matcher (exact
 * after normalising), `ask` when no employer is on file and there is a form to send them to. An
 * employer SVBC hasn't seen match gets nothing in v1 (the design's open question 1).
 */
export function promptVariant(employerName: string | null, cfg: OutreachConfig): PromptVariant | null {
  const typed = employerName?.trim() ?? '';
  if (typed === '') return cfg.employerFormUrl === null ? null : { kind: 'ask' };
  const wanted = normalizeEmployerName(typed);
  if (wanted === '') return null;
  const employer = cfg.matchingEmployers.find((e) => [e.name, ...e.aliases].some((s) => normalizeEmployerName(s) === wanted));
  return employer ? { kind: 'known', employer } : null;
}
