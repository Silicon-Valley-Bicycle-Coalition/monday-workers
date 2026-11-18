// Which deployment this isolate is: production (the default) or sandbox (`wrangler deploy --env
// sandbox`, which sets the ENVIRONMENT var). Mirrors member-portal/src/environment.ts — kept as
// its own copy per this repo's "each Worker is self-contained" convention.
import type { FeedbackBoardConfig } from './feedbackItem';
import type { SendStatusConfig } from './sendStatus';

export type Environment = 'production' | 'sandbox';

export interface EnvironmentBindings {
  ENVIRONMENT?: string;
}

export function environmentOf(env: EnvironmentBindings): Environment {
  const value = env.ENVIRONMENT;
  if (value === undefined || value === '' || value === 'production') return 'production';
  if (value === 'sandbox') return 'sandbox';
  // Fail closed: an unrecognized name could be a typo'd "sandbox" about to hit production config.
  throw new Error(`ENVIRONMENT var must be "sandbox" or unset (production); got "${value}"`);
}

export interface WorkerConfig {
  feedbackFormUrl: string;
  fromAddress: string;
  fromName: string;
  // Absolute URL to the branded PNG logo — served by member-portal's GET /email/logo.png (this
  // Worker has no copy of its own), so this must point at the matching member-portal environment
  // (production vs sandbox), not necessarily this Worker's own.
  logoUrl: string;
  // Where the organizer's address and the event name are read from (GL#66) — never the webhook
  // body. Needs Monday access (the MONDAY_AUTH binding, or MONDAY_API_TOKEN).
  board: FeedbackBoardConfig;
  // Where to write Sent/Failed back onto the item after each send (see src/sendStatus.ts), or
  // null to only log the outcome. Uses the same Monday access when set.
  sendStatus: SendStatusConfig | null;
  // Per-item resend guard (GL#105, src/sendGuard.ts): an item emailed within this many hours is not
  // emailed again, however many webhooks arrive for it.
  resendCooldownHours: number;
}

export function configFor(env: EnvironmentBindings, production: WorkerConfig, sandbox: WorkerConfig): WorkerConfig {
  return environmentOf(env) === 'sandbox' ? sandbox : production;
}
