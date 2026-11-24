// A complete, signed-off-looking outreach block for tests. The shipped configs hold `outreach: null`.
export function rawOutreach(): Record<string, any> {
  return {
    mode: 'email',
    delayDays: 2,
    donorCooldownDays: 90,
    maxAttempts: 3,
    excludeGiftTypes: ['Event Ticket'],
    employerFormUrl: 'https://member.example.org/en/portal/info?field=employer',
    wordingApprovedOn: '2026-12-01',
    ein: '12-3456789',
    fromAddress: 'giving@mail.example.org',
    fromName: 'SVBC Giving',
    replyTo: 'giving@example.org',
    postalAddress: '1 Example St, San Jose, CA 95113',
    logoUrl: 'https://member.example.org/email/logo.png',
    donations: { matchPromptSent: 'date_prompt' },
    people: { employerName: 'text_employer', doNotSolicit: 'boolean_dns' },
    programSummary: { prompted: 'numeric_p', promptedMatched: 'numeric_pm', promptedMatchDollars: 'numeric_pmd' },
    matchingEmployers: [
      {
        name: 'Google', aliases: ['Alphabet'], platform: 'Benevity', requestUrl: 'https://give.example.com/google',
        steps: 'benevity-off-platform', deadlineNote: 'by the end of the following calendar year',
      },
      { name: 'Apple', aliases: [], platform: 'Benevity', requestUrl: null, steps: 'benevity-off-platform', deadlineNote: null },
    ],
  };
}
