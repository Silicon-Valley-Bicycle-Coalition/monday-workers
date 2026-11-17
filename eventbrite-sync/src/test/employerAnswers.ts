import { vi, expect, type Mock } from 'vitest';
import type { EmployerAnswerSink } from '../consumer/employerAnswer';
import type { AttendeeStore } from '../db/attendees';
import type { ProcessBatchDeps } from '../consumer/processBatch';

// The consumer suites' shared pieces for employer answers (Task 6, #127).

export const EMPLOYER_ANSWER = 'Acme Secret Widgets';
export const EMPLOYER_ANSWERS = [{ question_id: '30', question: 'Who is your employer?', type: 'text', answer: EMPLOYER_ANSWER }];
export const PERSON_ITEM_ID = '7001';
const PEOPLE_BOARD = 42; // testConfig's people-live

export function fakeEmployerSink(impl?: EmployerAnswerSink['recordEmployerAnswer']): EmployerAnswerSink & { recordEmployerAnswer: Mock } {
  return { recordEmployerAnswer: impl ? vi.fn(impl) : vi.fn().mockResolvedValue({ recorded: true }) };
}

// People answers the attendee's email with PERSON_ITEM_ID; every other board answers `other`.
export function peopleLookup(other: (boardId: number) => { id: string } | null = () => null) {
  return vi.fn().mockImplementation(async (boardId: number) => (boardId === PEOPLE_BOARD ? { id: PERSON_ITEM_ID } : other(boardId)));
}

export function withSink(deps: ProcessBatchDeps, sink: EmployerAnswerSink | null): ProcessBatchDeps {
  return { ...deps, employerAnswers: sink };
}

// Board write, then the answer, then the ledger's `written`: the call order the spec requires.
export function expectRecordedBetween(write: Mock, sink: { recordEmployerAnswer: Mock }, attendeeStore: AttendeeStore): void {
  const updateStatus = attendeeStore.updateStatus as unknown as Mock;
  const writtenIndex = updateStatus.mock.calls.findIndex((c) => c[1] === 'written');
  expect(writtenIndex).toBeGreaterThanOrEqual(0);
  const writeAt = write.mock.invocationCallOrder[0]!;
  const recordAt = sink.recordEmployerAnswer.mock.invocationCallOrder[0]!;
  expect(writeAt).toBeLessThan(recordAt);
  expect(recordAt).toBeLessThan(updateStatus.mock.invocationCallOrder[writtenIndex]!);
}

export function expectNotWritten(attendeeStore: AttendeeStore): void {
  expect((attendeeStore.updateStatus as unknown as Mock).mock.calls.some((c) => c[1] === 'written')).toBe(false);
}
