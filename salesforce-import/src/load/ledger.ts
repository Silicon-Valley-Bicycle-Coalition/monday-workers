import { existsSync } from 'node:fs';
import { appendNdjson, dataPath, readNdjson } from '../artifacts.js';

type Entry =
  | { kind: 'success'; sfId: string; board: string; itemId: string }
  | { kind: 'failure'; sfId: string; board: string; error: string }
  | { kind: 'link'; sfId: string; column: string };

export class Ledger {
  private successes = new Map<string, { board: string; itemId: string }>();
  private failuresMap = new Map<string, { sfId: string; board: string; error: string }>();
  private links = new Set<string>();
  private path = dataPath('load', 'ledger.ndjson');

  async load(): Promise<void> {
    this.successes.clear(); this.failuresMap.clear(); this.links.clear();
    if (!existsSync(this.path)) return;
    for (const e of await readNdjson<Entry>(this.path)) {
      if (e.kind === 'success') {
        this.successes.set(e.sfId, { board: e.board, itemId: e.itemId });
        this.failuresMap.delete(`${e.sfId}|${e.board}`);
      } else if (e.kind === 'failure') {
        this.failuresMap.set(`${e.sfId}|${e.board}`, e);
      } else this.links.add(`${e.sfId}|${e.column}`);
    }
  }
  has(sfId: string, board: string): boolean { return this.successes.get(sfId)?.board === board; }
  itemId(sfId: string): string | undefined { return this.successes.get(sfId)?.itemId; }
  failures(): { sfId: string; board: string; error: string }[] { return [...this.failuresMap.values()]; }
  linkDone(sfId: string, column: string): boolean { return this.links.has(`${sfId}|${column}`); }
  async recordSuccess(e: { sfId: string; board: string; itemId: string }): Promise<void> {
    this.successes.set(e.sfId, { board: e.board, itemId: e.itemId });
    this.failuresMap.delete(`${e.sfId}|${e.board}`);
    await appendNdjson(this.path, { kind: 'success', ...e });
  }
  async recordFailure(e: { sfId: string; board: string; error: string }): Promise<void> {
    this.failuresMap.set(`${e.sfId}|${e.board}`, e);
    await appendNdjson(this.path, { kind: 'failure', ...e });
  }
  async recordLink(sfId: string, column: string): Promise<void> {
    this.links.add(`${sfId}|${column}`);
    await appendNdjson(this.path, { kind: 'link', sfId, column });
  }
}
