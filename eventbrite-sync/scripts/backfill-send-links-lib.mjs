// Pure planning for backfill-send-links.mjs: which Events items need the Send event email link.
// The Worker's daily sweep uses the same module, so the two can't drift.
export { parseLink, planSendLinks, sendLink } from '../src/sendLinks/plan.ts';
