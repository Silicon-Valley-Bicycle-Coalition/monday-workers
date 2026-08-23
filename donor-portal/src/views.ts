import type { PortalView } from './types';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
    <form action="/logout" method="post"><button type="submit">Log out</button></form>
  `;
}
