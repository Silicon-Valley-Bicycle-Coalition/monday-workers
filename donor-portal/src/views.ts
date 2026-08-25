import type { PortalView } from './types';

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Wraps a view's HTML fragment in a minimal document so the browser has a real <title> and
// viewport meta — without it, browsers fall back to printing the bare URL in default print
// headers/footers, which is how the tax letter page used to print (see letterViews.letterView).
export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
  </head>
  <body>
    ${body}
  </body>
</html>`;
}

export function loginFormView(): string {
  return `
    <h1>SVBC Donor Portal</h1>
    <p>Enter your email to receive a login link.</p>
    <form action="/login" method="post">
      <input type="email" name="email" required />
      <button type="submit">Send login link</button>
    </form>
  `;
}

export function checkEmailView(): string {
  return `
    <h1>Check your email</h1>
    <p>Please check your email: if that address is on file, a login link is on its way. It expires soon and can only be used once.</p>
  `;
}

export function errorView(message: string): string {
  return `
    <h1>Something went wrong</h1>
    <p>${escapeHtml(message)}</p>
    <p><a href="/login">Request a new login link</a></p>
  `;
}

function donationRow(donation: PortalView['donors'][number]['donations'][number]): string {
  return `
    <tr>
      <td>${escapeHtml(donation.date)}</td>
      <td>${escapeHtml(donation.amount)}</td>
      <td>${escapeHtml(donation.description)}</td>
    </tr>
  `;
}

function donorSection(donor: PortalView['donors'][number]): string {
  return `
    <section>
      <h2>${escapeHtml(donor.name)}</h2>
      <p>Membership: ${escapeHtml(donor.membershipStatus)} (${escapeHtml(donor.membershipTier)})</p>
      <p>Total donated: ${escapeHtml(donor.totalDonated)}</p>
      <table>
        <thead>
          <tr><th>Date</th><th>Amount</th><th>Description</th></tr>
        </thead>
        <tbody>
          ${donor.donations.map(donationRow).join('')}
        </tbody>
      </table>
    </section>
  `;
}

function discountRow(discount: PortalView['discounts'][number]): string {
  return `<li>${escapeHtml(discount.name)}: ${escapeHtml(discount.discountOffered)}</li>`;
}

export function portalView(data: PortalView): string {
  return `
    <h1>Your donor portal</h1>
    ${data.donors.map(donorSection).join('')}
    <section>
      <h2>Bike shop discounts</h2>
      <ul>
        ${data.discounts.map(discountRow).join('')}
      </ul>
    </section>
    <p><a href="/portal/letters">Tax documents</a></p>
    <p><a href="/portal/change-request">Request a change to your details</a></p>
    <form action="/logout" method="post"><button type="submit">Log out</button></form>
  `;
}
