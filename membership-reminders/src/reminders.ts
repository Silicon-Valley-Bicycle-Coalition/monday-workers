import type { Config, Member, RunSummary } from './types';
import { targetDateForStage } from './dates';
import { isEligible, hasStamp, appendStamp } from './filter';
import { renderTemplate } from './templates';
import { withRetry } from './retry';
import type { sendReminderEmail } from './email';

export interface MondayClientLike {
  queryDueMembers(
    boardId: number,
    columns: Config['monday']['columns'],
    activeStatusValue: string,
    targetDateISO: string,
  ): Promise<Member[]>;
  stampReminderSent(
    itemId: string,
    boardId: number,
    columnId: string,
    newValue: string,
  ): Promise<void>;
}

export interface ReminderDeps {
  monday: MondayClientLike;
  sendEmail: typeof sendReminderEmail;
}

const RETRY_OPTIONS = { attempts: 3, delayMs: 200 };

export async function runReminders(config: Config, deps: ReminderDeps): Promise<RunSummary> {
  if (!config.monday.donorsBoardId) {
    throw new Error(
      'reminders: monday.donorsBoardId is not configured — set it once the sandbox Donors board exists',
    );
  }
  const placeholderColumn = Object.entries(config.monday.columns).find(([, value]) =>
    typeof value === 'string' && value.startsWith('REPLACE_WITH_'),
  );
  if (placeholderColumn) {
    throw new Error(
      `reminders: monday.columns.${placeholderColumn[0]} still has a placeholder value — set it once the sandbox Donors board exists`,
    );
  }
  const boardId = config.monday.donorsBoardId;
  const summary: RunSummary = { stages: {} };

  for (const stage of config.stages) {
    const targetDate = targetDateForStage(stage.offsetDays, config.timeZone);
    const counts = { sent: 0, skipped: 0, failed: 0, stampFailed: 0, queryFailed: false };
    summary.stages[stage.tag] = counts;

    try {
      const members = await withRetry(
        () =>
          deps.monday.queryDueMembers(boardId, config.monday.columns, config.activeStatusValue, targetDate),
        RETRY_OPTIONS,
      );

      for (const member of members) {
        if (!isEligible(member, config.lifetimeTierValue, config.activeStatusValue)) {
          counts.skipped++;
          continue;
        }
        if (member.memberUntil !== targetDate) {
          counts.skipped++;
          continue;
        }
        if (hasStamp(member.remindersSent, stage, member.memberUntil)) {
          counts.skipped++;
          continue;
        }

        const email = renderTemplate(stage, {
          name: member.name,
          memberUntil: member.memberUntil,
          renewalUrl: config.renewalUrl,
        });

        try {
          await withRetry(() => deps.sendEmail({ email: member.email, name: member.name }, email), RETRY_OPTIONS);
        } catch (sendErr) {
          counts.failed++;
          console.error(
            `[membership-reminders] failed to send stage=${stage.tag} member=${member.id}: ${(sendErr as Error).message}`,
          );
          continue;
        }

        counts.sent++;

        try {
          const newValue = appendStamp(member.remindersSent, stage, member.memberUntil);
          await withRetry(
            () => deps.monday.stampReminderSent(member.id, boardId, config.monday.columns.remindersSent, newValue),
            RETRY_OPTIONS,
          );
        } catch (stampErr) {
          counts.stampFailed++;
          console.error(
            `[membership-reminders] sent but failed to stamp stage=${stage.tag} member=${member.id}: ${(stampErr as Error).message}`,
          );
        }
      }
    } catch (stageErr) {
      counts.queryFailed = true;
      console.error(
        `[membership-reminders] failed to query members for stage=${stage.tag}: ${(stageErr as Error).message}`,
      );
      continue;
    }
  }

  const hasFailures = Object.values(summary.stages).some(
    (s) => s.failed > 0 || s.stampFailed > 0 || s.queryFailed,
  );
  const logFn = hasFailures ? console.error : console.log;
  logFn(`[membership-reminders] run summary: ${JSON.stringify(summary)}`);

  return summary;
}
