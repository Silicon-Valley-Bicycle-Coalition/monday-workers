// Turns an Eventbrite event's questions into its pledge.events config block, for a person to review.
// Questions change every year, so this matches on their English wording.

const FIELD_RULES = [
  [/zip code/i, 'zip'],
  [/i pledge to ride/i, 'daysPledged'],
  [/check a box for whichever|i consider myself/i, 'riderType'],
  [/how did you hear/i, 'heardAbout'],
  [/who asked you/i, 'whoAsked'],
  [/authorize/i, 'consent'],
];
// Nobody asked for these on a board; they stay in Eventbrite.
const IGNORED = [/^age\b/i, /^ethnicity/i, /^gender/i];
const LABEL_FIELDS = ['daysPledged', 'riderType', 'heardAbout'];

export function buildEventConfig(questions, year) {
  const config = { year, questions: {}, ignoreQuestions: [], choices: {}, consentValues: [] };
  const notes = [];
  for (const question of questions) {
    const id = String(question.id);
    const text = question.question?.text ?? '';
    const choices = (question.choices ?? []).map((choice) => choice.answer?.text ?? '');
    if (IGNORED.some((rule) => rule.test(text))) {
      config.ignoreQuestions.push(id);
      continue;
    }
    const field = FIELD_RULES.find(([rule]) => rule.test(text))?.[1];
    if (field === undefined) {
      notes.push(`Question ${id} matched nothing, so its answers go to Other Answers: ${text}`);
      continue;
    }
    config.questions[id] = field;
    if (field === 'consent') config.consentValues.push(...choices);
    if (LABEL_FIELDS.includes(field)) {
      for (const choice of choices) config.choices[choice] = labelFor(choice, notes);
    }
  }
  return { config, notes };
}

// Answers are bilingual as "English/Spanish". A slash can also be part of the English, so every cut
// is shown for review, and a choice with more than one slash is left for a person.
function labelFor(choice, notes) {
  const parts = choice.split('/');
  if (parts.length === 1) return choice.trim();
  if (parts.length > 2) {
    notes.push(`Choice "${choice}" has more than one slash. Set its label by hand`);
    return choice;
  }
  const label = parts[0].trim();
  notes.push(`Choice "${choice}" is labeled "${label}". Check that's right`);
  return label;
}
