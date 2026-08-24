import type { StageConfig } from './types';

export interface TemplateData {
  name: string;
  memberUntil: string;
  renewalUrl: string;
}

export interface RenderedEmail {
  subject: string;
  body: string;
}

const SUBJECTS: Record<string, string> = {
  '6w': 'Your SVBC membership renews in 6 weeks',
  '4w': 'Your SVBC membership renews in 4 weeks',
  '2w': 'Your SVBC membership renews in 2 weeks',
};

const INTROS: Record<string, string> = {
  '6w': 'just a heads-up that your membership is coming up for renewal.',
  '4w': 'your membership renews soon — here is a reminder to renew.',
  '2w': 'your membership renews very soon. This is your final reminder.',
};

export function renderTemplate(stage: StageConfig, data: TemplateData): RenderedEmail {
  const subject = SUBJECTS[stage.tag];
  const intro = INTROS[stage.tag];
  if (!subject || !intro) {
    throw new Error(`templates: no template defined for stage "${stage.tag}"`);
  }
  const body = [
    `Hi ${data.name},`,
    '',
    intro,
    '',
    `Your membership expires on ${data.memberUntil}.`,
    `Renew here: ${data.renewalUrl}`,
    '',
    'Thanks for being a member of Silicon Valley Bicycle Coalition!',
  ].join('\n');
  return { subject, body };
}
