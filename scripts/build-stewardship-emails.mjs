// Builds the five stewardship emails (docs/runbooks/stewardship-sequences.md) as HTML for the
// Monday Sequence editor's <> button. They follow docs/design-system (EmailLayout). Edit the copy
// here, run `node scripts/build-stewardship-emails.mjs`, then paste each file from
// docs/email-branding/stewardship/ into the Sequence of the same name by hand: Monday has no API
// for editing a Sequence's email.
//
// {pulse.<column id>} is Monday's merge field, for production People. One line per file and no
// <head> or <style>: Monday strips both, so dark mode isn't styled.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const OUTPUT_DIR = new URL('../docs/email-branding/stewardship/', import.meta.url);

const FIRST_NAME = '{pulse.text_mm8scaqj}';
const LAST_GIFT_AMOUNT = '{pulse.numeric_mm8pd89h}';
const MEMBER_UNTIL = '{pulse.date_mm8n6xgb}';

const SITE = 'https://bikesiliconvalley.org';
const SUPPORT = `${SITE}/join-and-support`;
const VOLUNTEER = `${SUPPORT}/volunteer-with-svbc`;
// Hosted by member-portal, and the R2 bucket svbc-email-images.
const LOGO = 'https://member.bikesiliconvalley.org/email/logo.png';
const PHOTOS = 'https://images.bikesiliconvalley.org/email';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";
// Replaced with the email's own tags once it's rendered.
const UTM = '@UTM@';

const p = (text, margin = '0 0 16px') => `<p style="margin:${margin};">${text}</p>`;
const strong = (text) => `<strong>${text}</strong>`;
const link = (url, text) =>
  `<a class="em-link" href="${url}?${UTM}" style="color:#303030; text-decoration:underline; text-underline-offset:0.2em;">${text}</a>`;
const table = (style, body) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${style}">${body}</table>`;

// A sand box; the first paragraph is its heading.
const panel = (...paragraphs) => {
  const body = paragraphs.map((text, i) => p(text, i === paragraphs.length - 1 ? '0' : '0 0 12px')).join('');
  return table(
    'margin:0 0 24px;',
    `<tr><td class="em-panel em-text" style="background:#F0EBE8; border-radius:8px; padding:20px 24px; color:#303030; font-family:${FONT}; font-size:16px; line-height:1.5;">${body}</td></tr>`,
  );
};

const RENEW_BUTTON = `<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:0 auto 32px;"><tr><td style="background:#FFC20E; border-radius:300px; text-align:center;"><a href="${SUPPORT}/how-to-make-a-gift?${UTM}" style="display:inline-block; padding:16px 20.8px; color:#000000; font-family:${FONT}; font-size:16px; font-weight:400; line-height:1.25; text-decoration:none;">Renew Your Gift Today</a></td></tr></table>`;

const WHY_LINK = link(`${SUPPORT}/why-give`, 'Why Your Gift Matters');
const PERKS_LINK = link(`${SUPPORT}/celebrating-our-donors/donor-perks-and-discounts`, 'Donor Perks and Discounts');
const WHY = `${WHY_LINK} to see how your support sustains our work, strengthens our advocacy, and helps create safer, more accessible bicycling communities throughout San Mateo and Santa Clara Counties.`;
const PERKS = `${PERKS_LINK}, including exclusive savings at local, bike-friendly businesses.`;
const THANKS = 'Thank you for being part of the SVBC community and for helping create a Silicon Valley that values, includes, and encourages bicycling for all purposes and all people.';
const ALONGSIDE = 'We’re grateful to have you alongside us.';
const SUPPORT_TODAY = p(strong(link(SUPPORT, 'Your support today makes this work possible') + '.'));

const renewalOpening = (what) =>
  p(`Thank you for standing with the Silicon Valley Bicycle Coalition and ${what}. Your annual support of SVBC is due for renewal. Your membership stays active through ${MEMBER_UNTIL}. We hope you’ll renew your generosity and continue investing in safer streets and stronger, more connected communities.`);

const WHAT_WE_DO = ['Community. Safety. Advocacy. Education.', 'It’s what we do.'];
const SAFER = ['You can make biking safer for them.', 'Give the gift of safety with a donation to SVBC'];

export const EMAILS = [
  {
    slug: 'welcome-day-after',
    sequence: 'Welcome: day after',
    campaign: 'new-member-welcome-1',
    photo: 'group-ride-82c4bb8b6837ddff.jpg',
    alt: 'People on bikes riding together, and a rider in a protected bike lane.',
    band: WHAT_WE_DO,
    body: [
      p('Welcome to Silicon Valley Bicycle Coalition!'),
      p(`Thank you for your generous gift of ${strong(`$${LAST_GIFT_AMOUNT}`)} and for believing in a future where everyone can ride safely, confidently, and accessibly. By choosing to support SVBC, you’re doing more than making a donation—you’re investing in healthier communities, safer streets, and a more equitable future for all road users.`),
      p(`${strong('Your generosity makes this work possible.')} Because of supporters like you, we’re able to expand access to bicycling education, advocate for safer streets and connected communities, and create opportunities for more people to experience the freedom and wellness benefits of riding a bike.`),
      p(strong('We’re grateful to have you alongside us, and we’d love for you to be part of the community you’re helping make stronger.'), '0 0 24px'),
      panel(strong('1. Discover the 5 Reasons Your Gift to SVBC Matters'), `Explore ${WHY}`),
      panel(
        strong('2. Make a Difference in Your Community'),
        `Whether you’re new to biking or a seasoned cyclist, explore our ${link(`${SITE}/resources/how-to-start`, 'Resource Page')} for cycling tips, commuting resources, and ideas for discovering more of Silicon Valley by bike.`,
        `Want to meet fellow cyclists, advocate for safer streets, and help shape the future of bicycling in your city? Join a ${link(`${SITE}/biketivism/local-teams`, 'Local Team')} and connect with neighbors who share your passion.`,
      ),
      panel(
        strong('3. Be Part of the Action'),
        `From community outreach and educational events to our signature rides and advocacy efforts, there are so many ways to make a difference. Explore our ${link(VOLUNTEER, 'volunteer opportunities')} and ${link(VOLUNTEER, 'sign up for our biweekly volunteer newsletter')} to stay connected.`,
      ),
      p('I’m always happy to hear from you. My specialty is connecting people with opportunities to get involved! Thank you again for believing in our mission and investing in safer, healthier, and more connected communities.'),
      p('We are grateful to have you riding alongside us!'),
    ],
  },
  {
    slug: 'welcome-3-weeks',
    sequence: 'Welcome: 3 weeks',
    campaign: 'new-member-welcome-2',
    photo: 'booth-and-class-9368d4c283a34452.jpg',
    alt: 'Volunteers at an SVBC booth, and an instructor teaching a rider.',
    band: WHAT_WE_DO,
    body: [
      p('Thank you again for being part of the Silicon Valley Bicycle Coalition community! For over 30 years, SVBC has championed bike-friendly communities and safer streets.'),
      p('Your generosity helps make our work possible, from advocating for safer streets and better biking infrastructure to expanding bicycling education and creating more opportunities for people to ride. Behind every initiative, community partnership, and advocacy win is a dedicated team working to make Silicon Valley a safer, healthier, and more connected place.'),
      p('We’d love to introduce you to the teams whose work you’re helping advance. Each brings unique expertise and passion to our shared mission.', '0 0 24px'),
      panel(
        strong('Meet the SVBC Teams Behind the Movement'),
        `${strong(`${link(`${SITE}/learn-ride`, 'Programs Team')}:`)} Helps more people experience the joy and freedom of bicycling. From teaching bike safety and pedestrian skills to helping adults get started with bike commuting and organizing community rides, this team makes bicycling more accessible for people of all ages and abilities.`,
        `${strong(`${link(`${SITE}/biketivism/take-action`, 'Advocacy Team')}:`)} Works with communities, cities, and regional partners to make multimodal options, connectivity, and affordability priorities. SVBC advocates from the local to the state level to advance policies and programs that prioritize people-centered planning processes and design.`,
        `${strong(`${link(SUPPORT, 'Development &amp; Engagement Team')}:`)} Builds the relationships and resources that sustain the bike movement. From fundraising and donor stewardship to signature events and volunteer engagement, this team connects people who believe in our mission with opportunities to make a difference.`,
      ),
      p('Your generosity helps bring all of this work together. Every team plays an important role in advancing our mission, and your investment helps ensure they have the resources to keep moving this work forward.'),
      p('Thank you for being part of what makes this work possible. We’re grateful to have you alongside us!'),
    ],
    postscript: [
      p(`${strong(link(SUPPORT, 'Join and Support'))}: Discover all the ways you can support SVBC`, '0 0 4px'),
      p(`Explore ${strong(link(`${SUPPORT}/why-give`, 'how your gift makes a lasting impact'))}`, '0'),
    ],
  },
  {
    slug: 'renewal-3-weeks',
    sequence: 'Renewal: 3 weeks before',
    campaign: 'membership-renewal-3wk',
    photo: 'adult-and-toddler-d42b5006f7440b8a.jpg',
    alt: 'An adult and a toddler in helmets, riding together on one bike.',
    band: SAFER,
    body: [
      renewalOpening('helping build a stronger, safer bike community'),
      p('Every day, we work to make that vision a reality. From advocating for protected bike lanes and safer crossings to expanding bicycling education and creating more opportunities for people to ride, your generosity helps turn community priorities into meaningful progress. As transportation needs evolve and new challenges emerge, your continued support gives us the flexibility to respond, pursue critical opportunities, and keep this work moving forward.'),
      SUPPORT_TODAY,
      p('Today, we invite you to make your most generous gift possible. Your increased support helps accelerate advocacy campaigns, expand community programs, and advance safer streets and more accessible transportation for all.', '0 0 24px'),
      RENEW_BUTTON,
      panel(strong('The Impact of Giving:'), `Explore ${WHY}`, `Discover ${PERKS}`),
      p(THANKS),
      p(ALONGSIDE),
    ],
  },
  {
    slug: 'renewal-1-week',
    sequence: 'Renewal: 1 week before',
    campaign: 'membership-renewal-1wk',
    photo: 'three-kids-15b85ffaf6e0d406.jpg',
    alt: 'Three smiling kids in bike helmets and SVBC jerseys.',
    band: SAFER,
    body: [
      renewalOpening('supporting a stronger, safer bike community'),
      p('For more than 30 years, SVBC has championed bike-friendly communities, innovative programs, and improved multimodal options throughout Silicon Valley and across the state. We’ll keep fighting for streets that prioritize people and safety, while providing free bike programs that equip the next generation with the skills to ride safely.'),
      p('Your gift champions SVBC’s advocacy, education, and community programs throughout San Mateo and Santa Clara Counties. Because of donors like you, we can work toward safer, more accessible communities and a region where everyone has access to safe, convenient, and affordable ways to get around.'),
      p('Every day, SVBC works to make our streets safer, our communities healthier, and our region more connected. But meaningful change doesn’t happen on its own—it happens because supporters like you invest in a future where everyone can move safely and confidently, whether walking, biking, or rolling.'),
      p(`Today, we invite you to make your most generous contribution possible and to explore all the ways you can ${strong(link(SUPPORT, 'join and support'))} SVBC as a donor. An increased investment can help accelerate essential advocacy campaigns, expand community programs, and build momentum for lasting change.`, '0 0 24px'),
      RENEW_BUTTON,
      panel(strong('Your Impact &amp; Explore Donor Perks'), `Explore ${WHY}`, `Discover ${PERKS}`),
      p(THANKS),
      p(ALONGSIDE),
    ],
  },
  {
    slug: 'renewal-day-of',
    sequence: 'Renewal: day of',
    campaign: 'membership-renewal-dayof',
    photo: 'bike-lanes-hero-a283dbe682900830.jpg',
    alt: 'A protected bike lane curving along a tree-lined street.',
    band: ['Want better bike lanes? Support SVBC!'],
    body: [
      renewalOpening('helping build a stronger, safer bike community'),
      p('For more than 30 years, SVBC has championed bike-friendly communities, innovative programs, and improved multimodal options throughout Silicon Valley and across the state. With your support, that work continues. We’re fighting for streets that prioritize people and safety while providing free bicycling programs that equip the next generation with the skills and confidence to ride safely.'),
      SUPPORT_TODAY,
      p('SVBC’s advocacy, education, and community programs span throughout San Mateo and Santa Clara Counties. Because of donors like you, we can advance safer streets, expand access to bicycling, and help create a region where everyone has safe, convenient, and affordable ways to get around.'),
      p('Meaningful change doesn’t happen on its own. It happens when people like you invest in a future where everyone can move safely and confidently, whether walking, biking, or rolling.'),
      p('Today, we invite you to make your most generous contribution possible. An increased investment helps accelerate critical advocacy campaigns, expand community programs, and seize opportunities to create lasting change. Every gift moves us forward.', '0 0 24px'),
      RENEW_BUTTON,
      panel(strong('Discover the Impact of Your Gift &amp; Enjoy Exclusive Donor Benefits'), `Visit ${WHY}`, PERKS),
      p(`${THANKS} ${ALONGSIDE}`),
    ],
  },
];

export function renderEmail({ campaign, photo, alt, band: [headline, subhead], body, postscript = [] }) {
  const cell = (classes, style, html) =>
    `<tr><td class="${classes}" style="background:#FFFFFF; ${style} font-family:${FONT}; font-size:16px; line-height:1.5;">${html}</td></tr>`;
  const rows = [
    `<tr><td style="background:#000000; padding:24px; text-align:center; border-radius:8px 8px 0 0;"><a href="${SITE}/?${UTM}"><img src="${LOGO}" width="235" height="90" alt="Silicon Valley Bicycle Coalition" style="display:block; margin:0 auto; max-width:235px; width:100%; height:auto; border:0;"></a></td></tr>`,
    `<tr><td style="background:#FFC20E; font-size:0; line-height:0;"><img src="${PHOTOS}/${photo}" width="560" alt="${alt}" style="display:block; width:100%; max-width:560px; height:auto; border:0;"></td></tr>`,
    `<tr><td class="em-pad" style="background:#FFC20E; color:#000000; padding:16px 24px; text-align:center; font-family:${FONT}; font-size:24px; line-height:1.3; font-weight:500;">${headline}${subhead ? `<br><span style="font-size:16px; font-weight:400;">${subhead}</span>` : ''}</td></tr>`,
    cell('em-card em-text em-pad', 'color:#303030; padding:32px 24px 8px;', [
      p(`Hi ${FIRST_NAME},`),
      ...body,
      p('With gratitude,', '0 0 4px'),
      p(`${strong('Felicia Ward')}<br>Development Director<br>Silicon Valley Bicycle Coalition`, '0 0 24px'),
    ].join('')),
    cell('em-card em-text em-pad', 'color:#303030; padding:0 24px 32px; text-align:center;', '<em>“Nothing compares to the simple pleasure of riding a bike.”</em><br><strong>— John F. Kennedy</strong>'),
    postscript.length > 0 ? cell('em-card em-text em-pad', 'color:#303030; padding:0 24px 24px;', postscript.join('')) : '',
    // Monday swaps its own unsubscribe URL into this anchor when it sends.
    `<tr><td class="em-card em-muted em-pad" style="background:#FFFFFF; color:#666666; padding:16px 24px 32px; border-radius:0 0 8px 8px; text-align:center; font-family:${FONT}; font-size:12px; line-height:1.5;"><p style="margin:0 0 8px;">Silicon Valley Bicycle Coalition · <a href="${SITE}/?${UTM}" style="color:#666666;">bikesiliconvalley.org</a><br>95 South Market Street, Suite 648, San Jose, CA 95113</p><p style="margin:0;"><a class="crm-composer-unsubscribe-link-anchor-element" href="#" data-unsubscribe="true" data-read-only-link="true" style="color:#666666;">Unsubscribe from member emails</a></p></td></tr>`,
  ].join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="em-wrap" style="background:#F0EBE8;"><tr><td align="center" style="padding:24px 16px;">${table('max-width:560px;', rows)}</td></tr></table>`
    .replaceAll(UTM, `utm_source=monday&amp;utm_medium=email&amp;utm_campaign=${campaign}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const email of EMAILS) writeFileSync(new URL(`${email.slug}.html`, OUTPUT_DIR), `${renderEmail(email)}\n`);
  console.log(`Wrote ${EMAILS.length} emails to ${fileURLToPath(OUTPUT_DIR)}`);
}
