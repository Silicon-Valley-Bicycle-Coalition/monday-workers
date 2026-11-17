import { describe, it, expect, vi, afterEach } from 'vitest';
import { recordEmployerAnswer, answeredAtOf, type EmployerAnswerSink } from './employerAnswer';
import { testConfig } from '../test/testConfig';
import type { EventbriteAttendee } from '../eventbrite/client';
import type { MondayClient } from '../monday/client';
import type { EventbriteSyncConfig } from '../types';
import type { ProcessBatchDeps } from './processBatch';

const ANSWER = 'Acme Widgets Secret';

function attendee(overrides: Partial<EventbriteAttendee> = {}): EventbriteAttendee {
  return {
    id: 'a1', event_id: '9001', created: '2026-05-01T20:00:00Z', cancelled: false, refunded: false,
    profile: { name: 'Pat Rider', email: 'pat@example.com' },
    answers: [{ question_id: '30', question: 'Who is your employer?', type: 'text', answer: `  ${ANSWER} ` }],
    ...overrides,
  };
}

function setup(opts: { sink?: EmployerAnswerSink | null; person?: string | null; config?: EventbriteSyncConfig } = {}) {
  const mondayClient = {
    findItemByColumnValue: vi.fn().mockResolvedValue(opts.person === null ? null : { id: opts.person ?? '7001' }),
    createItem: vi.fn(),
    changeColumnValues: vi.fn(),
    getItems: vi.fn(),
    postUpdate: vi.fn(),
    createTimelineItem: vi.fn(),
  } as unknown as MondayClient;
  const sink = opts.sink === undefined ? { recordEmployerAnswer: vi.fn().mockResolvedValue({ recorded: true }) } : opts.sink;
  const deps = { mondayClient, config: opts.config ?? testConfig(), employerAnswers: sink } as unknown as ProcessBatchDeps;
  return { deps, mondayClient, sink };
}

afterEach(() => vi.restoreAllMocks());

describe('recordEmployerAnswer', () => {
  it('looks the attendee up on People by email and hands the answer over', async () => {
    const { deps, mondayClient, sink } = setup();
    await recordEmployerAnswer(attendee(), null, 'Adult Learn to Ride', deps);
    expect(mondayClient.findItemByColumnValue).toHaveBeenCalledWith(42, 'people_email_col', 'pat@example.com');
    expect(mondayClient.createItem).not.toHaveBeenCalled();
    expect(sink!.recordEmployerAnswer).toHaveBeenCalledWith({
      source: 'eventbrite', sourceId: 'a1', personItemId: '7001', answer: ANSWER, answeredAt: '2026-05-01', context: 'Adult Learn to Ride',
    });
  });

  it('does nothing without a binding', async () => {
    const { deps, mondayClient } = setup({ sink: null });
    await recordEmployerAnswer(attendee(), null, '', deps);
    expect(mondayClient.findItemByColumnValue).not.toHaveBeenCalled();
    // A test fake (or an older deps object) may leave the field out entirely: same as null.
    const missing = { ...deps } as Partial<ProcessBatchDeps>;
    delete missing.employerAnswers;
    await recordEmployerAnswer(attendee(), null, '', missing as ProcessBatchDeps);
    expect(mondayClient.findItemByColumnValue).not.toHaveBeenCalled();
  });

  it('does nothing while config.employerAnswers.enabled is false', async () => {
    const config = { ...testConfig(), employerAnswers: { enabled: false } };
    const { deps, mondayClient, sink } = setup({ config });
    await recordEmployerAnswer(attendee(), null, '', deps);
    expect(mondayClient.findItemByColumnValue).not.toHaveBeenCalled();
    expect(sink!.recordEmployerAnswer).not.toHaveBeenCalled();
  });

  it.each([{ cancelled: true }, { refunded: true }])('skips a %o attendee', async (flags) => {
    const { deps, mondayClient, sink } = setup();
    await recordEmployerAnswer(attendee(flags), null, '', deps);
    expect(mondayClient.findItemByColumnValue).not.toHaveBeenCalled();
    expect(sink!.recordEmployerAnswer).not.toHaveBeenCalled();
  });

  it('skips a placeholder "Info Requested" email, and never looks up the buyer', async () => {
    const { deps, mondayClient, sink } = setup();
    await recordEmployerAnswer(attendee({ profile: { name: 'Info Requested Info Requested', email: 'Info Requested' } }), null, '', deps);
    expect(mondayClient.findItemByColumnValue).not.toHaveBeenCalled();
    expect(sink!.recordEmployerAnswer).not.toHaveBeenCalled();
  });

  it('skips the People lookup when there is no answer', async () => {
    const { deps, mondayClient, sink } = setup();
    await recordEmployerAnswer(attendee({ answers: [] }), null, '', deps);
    expect(mondayClient.findItemByColumnValue).not.toHaveBeenCalled();
    expect(sink!.recordEmployerAnswer).not.toHaveBeenCalled();
  });

  it('records nothing, and creates no one, when People has no match', async () => {
    const { deps, mondayClient, sink } = setup({ person: null });
    await recordEmployerAnswer(attendee(), null, '', deps);
    expect(mondayClient.findItemByColumnValue).toHaveBeenCalledTimes(1);
    expect(mondayClient.createItem).not.toHaveBeenCalled();
    expect(sink!.recordEmployerAnswer).not.toHaveBeenCalled();
  });

  it('truncates the answer to 200 characters', async () => {
    const { deps, sink } = setup();
    await recordEmployerAnswer(attendee({ answers: [{ question_id: '30', question: 'Employer', type: 'text', answer: 'x'.repeat(250) }] }), null, '', deps);
    expect((sink!.recordEmployerAnswer as ReturnType<typeof vi.fn>).mock.calls[0]![0].answer).toHaveLength(200);
  });

  it('uses a pledge event\'s mapped employer question', async () => {
    const { deps, sink } = setup();
    const pledgeEvent = { year: 2027, questions: { '40': 'employer' as const }, ignoreQuestions: [], choices: {}, consentValues: [] };
    const att = attendee({ answers: [
      { question_id: '30', question: 'Who is your employer?', type: 'text', answer: 'Not this one' },
      { question_id: '40', question: 'Company', type: 'text', answer: ANSWER },
    ] });
    await recordEmployerAnswer(att, pledgeEvent, 'Pledge to Ride 2027', deps);
    expect(sink!.recordEmployerAnswer).toHaveBeenCalledWith(expect.objectContaining({ answer: ANSWER, context: 'Pledge to Ride 2027' }));
  });

  it('resolves on { recorded: false } and logs ids and the reason only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps } = setup({ sink: { recordEmployerAnswer: vi.fn().mockResolvedValue({ recorded: false, reason: 'non-answer' }) } });
    await expect(recordEmployerAnswer(attendee(), null, 'Secret Context', deps)).resolves.toBeUndefined();
    const text = [...warn.mock.calls, ...log.mock.calls].flat().map(String).join('\n');
    expect(text).toContain('attendee a1 employer answer not recorded: non-answer');
    expect(text).not.toContain(ANSWER);
    expect(text).not.toContain('Secret Context');
    expect(text).not.toContain('pat@example.com');
  });

  it('rethrows a thrown error, so the message retries', async () => {
    const { deps } = setup({ sink: { recordEmployerAnswer: vi.fn().mockRejectedValue(new Error('D1 unavailable')) } });
    await expect(recordEmployerAnswer(attendee(), null, '', deps)).rejects.toThrow('D1 unavailable');
  });

  it('never puts the answer in any console line', async () => {
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    for (const sink of [
      { recordEmployerAnswer: vi.fn().mockResolvedValue({ recorded: true }) },
      { recordEmployerAnswer: vi.fn().mockResolvedValue({ recorded: false, reason: 'closed' }) },
    ]) {
      const { deps } = setup({ sink });
      await recordEmployerAnswer(attendee(), null, 'ctx', deps);
      await recordEmployerAnswer(attendee(), null, 'ctx', setup({ sink, person: null }).deps);
    }
    expect(spies.flatMap((s) => s.mock.calls).flat().map(String).join('\n')).not.toContain(ANSWER);
  });
});

describe('answeredAtOf', () => {
  it('is the attendee\'s created date', () => {
    expect(answeredAtOf(attendee({ created: '2026-05-01T20:00:00Z' }), new Date('2026-11-17T00:00:00Z'))).toBe('2026-05-01');
  });

  it.each([null, undefined, '', 'garbage', '2026-13-45T00:00:00Z', '2026-02-30'])('falls back to today\'s UTC date for %o', (created) => {
    expect(answeredAtOf(attendee({ created }), new Date('2026-11-17T23:30:00Z'))).toBe('2026-11-17');
  });
});
