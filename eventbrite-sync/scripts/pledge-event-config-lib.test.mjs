import { describe, it, expect } from 'vitest';
import { buildEventConfig } from './pledge-event-config-lib.mjs';
import { validateConfig } from '../src/config';
import { testConfig, withPledge } from '../src/test/testConfig';

const q = (id, type, text, choices = []) => ({ id, type, question: { text }, choices: choices.map((c) => ({ answer: { text: c } })) });

const questions2026 = [
  q('319665211', 'radio', 'I pledge to ride my bike in May/Durante el mes de mayo, prometo andar en mi bici ...', ['1 day/Un día ', 'Multiple days/Varios días ', 'All month long!/ ¡Todo el mes!']),
  q('319665204', 'text', 'Home Zip Code/ Código postal de su hogar'),
  q('320892542', 'text', 'Who asked you to pledge?¿Quien te motivo a hacer tu prometa?'),
  q('319665210', 'checkbox', 'Check a box for whichever applies to you (optional)/ Elija la(s) caja(s) que apliquen para usted (opcional)', ['I am a new rider/ Andar en bici es nuevo para mi ']),
  q('319665213', 'checkbox', 'How did you hear about Bike to Work/Wherever Days? ¿Como te enterases?', ['Email/ Correo electrónico ', 'Banner/Flyer/Poster/Letrero/folleto']),
  q('319953628', 'radio', 'By submitting this form, I authorize Silicon Valley Bicycle Coalition to contact me', ['Yes/Si']),
  q('319848568', 'text', 'I see myself as/ Me describo como'),
];

const questions2025 = [
  q('266760173', 'text', 'Mailing Zip Code'),
  q('266760193', 'checkbox', 'Age', ['<13', '13-19']),
  q('266760183', 'checkbox', 'Ethnicity', ['Asian', 'Hispanic/Latinx']),
  q('266760203', 'checkbox', 'Gender', ['Female']),
  q('266760233', 'radio', 'During May, I pledge to ride at least...', ['1 day', '2-7 days', '> 7 days']),
  q('275733213', 'checkbox', 'I consider myself to be...', ['A newer bike rider', 'Very familiar/comfortable with cycling']),
  q('266760243', 'checkbox', 'How did you hear about Bike to Work/Wherever Days?', ['Email', 'Banner/Flyer/Poster']),
  q('275575423', 'radio', 'Is this your first time participating in BTWD?', ['Yes', 'No']),
];

describe('buildEventConfig 2026', () => {
  const { config, notes } = buildEventConfig(questions2026, 2026);

  it('maps the questions', () => {
    expect(config.year).toBe(2026);
    expect(config.questions).toEqual({
      319665211: 'daysPledged', 319665204: 'zip', 320892542: 'whoAsked', 319665210: 'riderType', 319665213: 'heardAbout', 319953628: 'consent',
    });
  });

  it('takes consent values from its choices', () => expect(config.consentValues).toEqual(['Yes/Si']));

  it('labels a bilingual choice with its English side', () => {
    expect(config.choices['Multiple days/Varios días ']).toBe('Multiple days');
    expect(config.choices['Email/ Correo electrónico ']).toBe('Email');
  });

  it('keeps an ambiguous choice whole and flags it', () => {
    expect(config.choices['Banner/Flyer/Poster/Letrero/folleto']).toBe('Banner/Flyer/Poster/Letrero/folleto');
    expect(notes.join('\n')).toContain('Banner/Flyer/Poster/Letrero/folleto');
  });

  it('leaves consent choices out of the labels', () => expect(config.choices).not.toHaveProperty('Yes/Si'));

  it('notes a question that will go to Other Answers', () => {
    expect(config.questions['319848568']).toBeUndefined();
    expect(notes.join('\n')).toContain('319848568');
  });

  it('passes the Worker config validation', () => {
    const cfg = JSON.parse(JSON.stringify(withPledge(testConfig())));
    cfg.pledge.events['1977741403778'] = config;
    expect(() => validateConfig(cfg)).not.toThrow();
  });
});

describe('buildEventConfig 2025', () => {
  const { config, notes } = buildEventConfig(questions2025, 2025);

  it('ignores age, ethnicity and gender', () => {
    expect(config.ignoreQuestions.sort()).toEqual(['266760183', '266760193', '266760203']);
    expect(config.choices).not.toHaveProperty('Hispanic/Latinx');
  });

  it('maps its different wording', () => {
    expect(config.questions['266760173']).toBe('zip');
    expect(config.questions['266760233']).toBe('daysPledged');
    expect(config.questions['275733213']).toBe('riderType');
  });

  it('has no consent question', () => expect(config.consentValues).toEqual([]));
  it('keeps a plain choice as it is', () => expect(config.choices['2-7 days']).toBe('2-7 days'));

  it('shows a label cut at a slash for review', () => {
    expect(config.choices['Very familiar/comfortable with cycling']).toBe('Very familiar');
    expect(notes.join('\n')).toContain('Very familiar/comfortable with cycling');
  });
});
