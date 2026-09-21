import rawConfig from '../config/local.json';
import { validateConfig } from './config';
import { createApp } from './routes';
import { D1MagicLinkTokenStore } from './db/tokens';
import { D1SessionStore } from './db/sessions';
import { D1LoginAttemptStore } from './db/loginAttempts';
import { D1ChangeRequestStore } from './db/changeRequests';
import { D1CardTokenStore } from './db/cardTokens';
import { FakeMondayClient } from './monday/fakeClient';
import { ConsoleEmailSender } from './email/devEmail';
import { processChangeQueueBatch } from './changeRequests/processBatch';
import { processLetterSendBatch } from './letters/processLetterSendBatch';
import { D1LetterSendStore } from './db/letterSends';
import type { ChangeQueueMessage, LetterSendQueueMessage } from './types';

// Local-preview-only entrypoint — see README's "Local preview with dummy data" section.
// Mirrors src/index.ts but swaps every external dependency (Monday's API, Cloudflare Email
// Sending) for an in-memory fake, so `npm run dev:local` never makes a network call or needs
// any secret. D1 and the queues are still real bindings — wrangler dev --local simulates both
// without touching any cloud resource. Never deploy this file or wrangler.local.jsonc.

interface LocalEnv {
  DB: D1Database;
  CHANGE_QUEUE: Queue<ChangeQueueMessage>;
  LETTER_SEND_QUEUE: Queue<LetterSendQueueMessage>;
}

// Always-succeed stand-in for the LOGIN_RATE_LIMITER binding (which wrangler.local.jsonc
// deliberately omits) — rate limiting has nothing to prove in a single-user local preview.
const noopIpLimiter = { limit: async () => ({ success: true }) };

// Not a real secret — this Worker only ever runs on localhost with dummy data.
const LOCAL_LETTER_WEBHOOK_SECRET = 'local-preview-secret';

function buildApp(env: LocalEnv) {
  const config = validateConfig(rawConfig);
  return createApp({
    monday: new FakeMondayClient(),
    tokenStore: new D1MagicLinkTokenStore(env.DB),
    sessionStore: new D1SessionStore(env.DB),
    attemptStore: new D1LoginAttemptStore(env.DB),
    emailSender: new ConsoleEmailSender(),
    ipLimiter: noopIpLimiter,
    config,
    now: () => new Date(),
    changeStore: new D1ChangeRequestStore(env.DB),
    changeQueue: { send: (message) => env.CHANGE_QUEUE.send(message).then(() => undefined) },
    letterSendStore: new D1LetterSendStore(env.DB),
    letterQueue: { send: (message) => env.LETTER_SEND_QUEUE.send(message).then(() => undefined) },
    letterWebhookSecret: LOCAL_LETTER_WEBHOOK_SECRET,
    cardTokenStore: new D1CardTokenStore(env.DB),
  });
}

export default {
  fetch(request: Request, env: LocalEnv, ctx: ExecutionContext) {
    return buildApp(env).fetch(request, env, ctx);
  },

  async queue(batch: MessageBatch<ChangeQueueMessage> | MessageBatch<LetterSendQueueMessage>, env: LocalEnv): Promise<void> {
    const config = validateConfig(rawConfig);
    const monday = new FakeMondayClient();

    if (batch.queue === 'member-portal-change-requests-local') {
      await processChangeQueueBatch([...(batch as MessageBatch<ChangeQueueMessage>).messages], {
        store: new D1ChangeRequestStore(env.DB),
        monday,
        config,
      });
      return;
    }

    if (batch.queue === 'member-portal-letter-emails-local') {
      await processLetterSendBatch([...(batch as MessageBatch<LetterSendQueueMessage>).messages], {
        store: new D1LetterSendStore(env.DB),
        monday,
        tokenStore: new D1MagicLinkTokenStore(env.DB),
        emailSender: new ConsoleEmailSender(),
        config,
        now: () => new Date(),
      });
      return;
    }

    throw new Error(`member-portal (local) queue: unrecognized queue "${batch.queue}"`);
  },
};
