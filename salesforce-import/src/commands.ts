type Handler = (args: string[]) => Promise<number>;
const commands = new Map<string, Handler>();

export function registerCommand(name: string, fn: Handler): void {
  commands.set(name, fn);
}

export async function runCli(argv: string[]): Promise<number> {
  const [name, ...args] = argv;
  const handler = name ? commands.get(name) : undefined;
  if (!handler) {
    console.error(`usage: cli <${[...commands.keys()].join('|')}> [options]`);
    return 2;
  }
  return handler(args);
}
