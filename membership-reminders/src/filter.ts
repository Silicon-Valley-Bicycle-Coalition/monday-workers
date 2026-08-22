import type { Member, StageConfig } from './types';

export function isEligible(member: Member, lifetimeTierValue: string): boolean {
  if (member.membershipTier === lifetimeTierValue) return false;
  if (!member.memberUntil) return false;
  return true;
}

export function stampValue(stage: StageConfig, memberUntil: string): string {
  return `${stage.tag}:${memberUntil}`;
}

export function hasStamp(remindersSent: string, stage: StageConfig, memberUntil: string): boolean {
  if (!remindersSent) return false;
  const target = stampValue(stage, memberUntil);
  return remindersSent
    .split(',')
    .map((s) => s.trim())
    .includes(target);
}

export function appendStamp(remindersSent: string, stage: StageConfig, memberUntil: string): string {
  const value = stampValue(stage, memberUntil);
  return remindersSent ? `${remindersSent}, ${value}` : value;
}
