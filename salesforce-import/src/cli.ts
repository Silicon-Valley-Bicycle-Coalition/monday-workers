import { runCli } from './commands.js';
// Stage modules self-register via registerCommand; imported here as they land:
import './extract/index.js';
import './geocode/index.js';
import './transform/index.js';
// import './load/index.js'; import './validate/index.js';

process.exitCode = await runCli(process.argv.slice(2));
