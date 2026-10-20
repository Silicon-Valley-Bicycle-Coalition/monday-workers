// Replies to the staff member who logged a message. Text-only on purpose: these are short
// operational notes, and plain text keeps the subject and addresses out of any HTML escaping.
// The wording asks staff to fix the record, never to log more mail ("significant touches only").
export interface ReplySender {
  sendUnmatched(to: string, subject: string, itemUrl: string, unmatched: string[], nothingMatched: boolean): Promise<void>;
  sendNotLogged(to: string, subject: string): Promise<void>;
}

export class CloudflareReplySender implements ReplySender {
  private readonly binding: SendEmail;
  private readonly from: { email: string; name: string };

  constructor(binding: SendEmail, from: { email: string; name: string }) {
    this.binding = binding;
    this.from = from;
  }

  async sendUnmatched(to: string, subject: string, itemUrl: string, unmatched: string[], nothingMatched: boolean): Promise<void> {
    let text =
      `Your email "${subject}" is on the Activities (Logged) board:\n${itemUrl}\n\n` +
      `These addresses aren't on anyone's record in Monday:\n${unmatched.map((a) => '- ' + a).join('\n')}\n\n` +
      'Add each address to the right person in Monday (or create the person), then link this item to them.';
    if (nothingMatched) text += '\n\nBecause no one matched, the item is marked Needs Person.';
    await this.send(to, `Logged to Monday, but some addresses aren't on file: ${subject}`, text);
  }

  async sendNotLogged(to: string, subject: string): Promise<void> {
    await this.send(
      to,
      `Couldn't log to Monday: ${subject}`,
      `Your email "${subject}" couldn't be logged to Monday after several tries. IT has been notified. Please try again later.`
    );
  }

  private async send(to: string, subject: string, text: string): Promise<void> {
    await this.binding.send({ from: this.from, to, subject, text });
  }
}
