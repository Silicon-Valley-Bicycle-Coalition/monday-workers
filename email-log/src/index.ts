import productionConfig from '../config/svbc.json';
import sandboxConfig from '../config/sandbox.json';
import { consumeLogBatch, type ConsumerDeps } from './consumer/processBatch';
import { processDeadLetters } from './consumer/processDeadLetters';
import { D1LoggedMessageStore } from './db/loggedMessages';
import { CloudflareReplySender } from './email/reply';
import { sandboxEmailBinding } from './email/sandboxBinding';
import { validateConfig } from './config';
import { createConfigSelector, environmentOf } from './environment';
import { handleEmail } from './inbound/handleEmail';
import type { LogQueueMessage } from './inbound/extract';
import { HttpMondayClient } from './monday/client';
import { readLogLevel, readWriteMode } from './flags';
import { EMAIL_LOG_PII_KEYS, type BatchSkipContext } from './writeSwitch';
import type { Env } from './types';

// One config per environment, chosen at request time from env.ENVIRONMENT and validated once
// per isolate — see src/environment.ts.
const configFor = createConfigSelector({ production: productionConfig, sandbox: sandboxConfig, validate: validateConfig });

const WORKER = 'email-log';

// The write switch's mode and log level, read once per queue batch (never cached per isolate, so a
// flip reaches the next batch within the KV edge cache's 30 s).
async function skipContext(env: Env): Promise<BatchSkipContext> {
  const [mode, logLevel] = await Promise.all([readWriteMode(env, WORKER), readLogLevel(env, WORKER)]);
  return { worker: WORKER, environment: environmentOf(env), mode, logLevel, piiKeys: EMAIL_LOG_PII_KEYS };
}

// Queue names from wrangler.jsonc, matched exactly: the sandbox DLQ ("…-sandbox-dlq") doesn't end
// in "-sandbox", so stripping a suffix can't route it.
const WRITE_QUEUE = 'email-log-writes';
const SANDBOX_WRITE_QUEUE = 'email-log-writes-sandbox';
const DEAD_LETTER_QUEUE = 'email-log-writes-dlq';
const SANDBOX_DEAD_LETTER_QUEUE = 'email-log-writes-sandbox-dlq';

export function isDeadLetterBatch(queueName: string): boolean {
  return queueName === DEAD_LETTER_QUEUE || queueName === SANDBOX_DEAD_LETTER_QUEUE;
}

/** Which consumer a batch goes to; throws for a queue this Worker doesn't consume. */
export function consumerFor(queueName: string): 'log' | 'dead-letter' {
  if (isDeadLetterBatch(queueName)) return 'dead-letter';
  if (queueName === WRITE_QUEUE || queueName === SANDBOX_WRITE_QUEUE) return 'log';
  throw new Error(`email-log: no consumer for queue "${queueName}"`);
}

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
      writeMode: () => readWriteMode(env, WORKER),
    });
  },

  // Both the write queue and its dead-letter queue are consumed here; wrangler.jsonc names them.
  async queue(batch: MessageBatch<LogQueueMessage>, env: Env): Promise<void> {
    const config = configFor(env);
    const consumer = consumerFor(batch.queue);
    const deps: ConsumerDeps = {
      config,
      store: new D1LoggedMessageStore(env.DB),
      monday: new HttpMondayClient(config.monday.apiUrl, env.MONDAY_API_TOKEN),
      reply: new CloudflareReplySender(replyBinding(env), config.mail.replyFrom),
      now: () => new Date(),
    };
    if (consumer === 'dead-letter') await processDeadLetters([...batch.messages], deps);
    else await consumeLogBatch([...batch.messages], deps, await skipContext(env));
  },
};
