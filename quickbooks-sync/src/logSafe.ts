// Workers Logs and Workers Issues forwarding reach more people than CRM access does, and
// scripts/check-log-safety.mjs only catches email-shaped text. Monday validation errors echo the
// submitted column values (donor name, email, company) and Intuit fault text names the Customer,
// so a failure is logged as its class and status/code only (#107). The full text stays in the D1
// `error` columns, which the retention pass purges.

/** `err` as `Name` plus `HTTP <status>` and `code <code>` when it carries them — never its message. */
export function errorClass(err: unknown): string {
  if (!(err instanceof Error)) return typeof err;
  const { httpStatus, code } = err as { httpStatus?: unknown; code?: unknown };
  const parts = [err.name];
  if (typeof httpStatus === 'number') parts.push(`HTTP ${httpStatus}`);
  if (typeof code === 'string' || typeof code === 'number') parts.push(`code ${code}`);
  return parts.join(' ');
}
