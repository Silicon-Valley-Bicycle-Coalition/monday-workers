import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { processLogBatch, type ConsumerDeps } from './consumer/processBatch';
import { processDeadLetters } from './consumer/processDeadLetters';
import { D1LoggedMessageStore } from './db/loggedMessages';
import { CloudflareReplySender } from './email/reply';
import { sandboxEmailBinding } from './email/sandboxBinding';
import { validateConfig } from './config';
import { createConfigSelector, environmentOf, queueBaseName } from './environment';
import { handleEmail } from './inbound/handleEmail';
import type { LogQueueMessage } from './inbound/extract';
import { HttpMondayClient } from './monday/client';
import type { Env } from './types';

// One config per environment, chosen at request time from env.ENVIRONMENT and validated once
// per isolate — see src/environment.ts.
const configFor = createConfigSelector({ production: productionConfig, sandbox: sandboxConfig, validate: validateConfig });

// Production queue names from wrangler.jsonc; the sandbox's carry a "-sandbox" suffix that
// queueBaseName strips, so one router serves both.
const WRITE_QUEUE = 'email-log-writes';
const DEAD_LETTER_QUEUE = 'email-log-writes-dlq';

// In the sandbox every reply goes to the sink (the platform's allowed_destination_addresses is the
// second lock). A missing sink fails closed rather than falling back to the real binding.
function replyBinding(env: Env): SendEmail {
  if (environmentOf(env) !== 'sandbox') return env.EMAIL;
  if (!env.SANDBOX_EMAIL_SINK) throw new Error('SANDBOX_EMAIL_SINK is not set; refusing to send sandbox email');
  return sandboxEmailBinding(env.EMAIL, env.SANDBOX_EMAIL_SINK);
}

export default {
  async email(message: ForwardableEmailMessage, env: Env, _ctx: ExecutionContext): Promise<void> {
    await handleEmail(message, {
      config: configFor(env),
      store: new D1LoggedMessageStore(env.DB),
      queue: env.WRITE_QUEUE,
      now: () => new Date(),
    });
  },

  // Both the write queue and its dead-letter queue are consumed here; wrangler.jsonc names them.
  async queue(batch: MessageBatch<LogQueueMessage>, env: Env): Promise<void> {
    const config = configFor(env);
    const base = queueBaseName(batch.queue);
    if (base !== WRITE_QUEUE && base !== DEAD_LETTER_QUEUE) {
      console.error(`email-log: batch from unexpected queue "${batch.queue}"`);
      throw new Error(`email-log: no consumer for queue "${batch.queue}"`);
    }
    const deps: ConsumerDeps = {
      config,
      store: new D1LoggedMessageStore(env.DB),
      monday: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
      reply: new CloudflareReplySender(replyBinding(env), config.mail.replyFrom),
      now: () => new Date(),
    };
    if (base === DEAD_LETTER_QUEUE) await processDeadLetters([...batch.messages], deps);
    else await processLogBatch([...batch.messages], deps);
  },
};
