import type { EventbriteSyncConfig } from '../types';

// One valid config for tests to start from, so each suite overrides only what it exercises.
// Ids are deliberately fake; config/sandbox.json has the real sandbox ids.
export function testConfig(
  eventbriteSync: Partial<EventbriteSyncConfig['eventbriteSync']> = {},
  boards: Partial<EventbriteSyncConfig['monday']['boards']> = {},
  eventbrite: Partial<EventbriteSyncConfig['eventbrite']> = {}
): EventbriteSyncConfig {
  return {
    monday: {
      apiUrl: 'https://api.monday.com/v2',
      boards: { 'donations:live': 111, 'people-live': 42, events: 222, 'event-registrations': 333, volunteers: 666, ...boards },
    },
    eventbrite: {
      apiUrl: 'https://www.eventbriteapi.com/v3',
      organizationId: null,
      actions: ['order.placed', 'order.updated', 'order.refunded'],
      ...eventbrite,
    },
    eventbriteSync: {
      orderIdColumn: 'order_id_col',
      amountColumn: 'amount_col',
      statusColumn: 'status_col',
      dateColumn: 'date_col',
      amountSource: 'gross',
      currency: 'USD',
      skipFreeOrders: true,
      statusLabelMap: { placed: 'Received', refunded: 'Refunded' },
      itemNameTemplate: '{buyer} - {event}',
      thankYouSentColumn: null,
      giftTypeColumn: null,
      giftTypeValue: 'Event Ticket',
      fiscalYearColumn: null,
      donorEmailColumn: 'email_col',
      donorFirstNameColumn: 'first_col',
      donorLastNameColumn: 'last_col',
      donorLinkColumn: 'connect_col',
      ...eventbriteSync,
    },
    attendeeSync: {
      actions: ['attendee.updated', 'attendee.checked_in', 'attendee.checked_out', 'event.created', 'event.published', 'event.updated', 'event.unpublished'],
      programByOrganizer: { 'org-volunteering': 'Volunteering' },
      volunteerPrograms: ['Volunteering'],
      zipPrograms: ['Public', 'Group Rides'],
      events: {
        eventbriteIdColumn: 'ev_id_col', dateColumn: 'ev_date_col', endColumn: 'ev_end_col', venueColumn: 'ev_venue_col',
        addressColumn: 'ev_address_col', cityColumn: 'ev_city_col', programColumn: 'ev_program_col', eventStatusColumn: 'ev_status_col',
        sourceColumn: 'ev_source_col', urlColumn: 'ev_url_col', sendLinkColumn: 'ev_send_col',
      },
      registrations: {
        attendeeIdColumn: 'att_col', attendeeNameColumn: 'att_name_col', attendeeEmailColumn: 'att_email_col', attendeePhoneColumn: 'att_phone_col', firstNameColumn: 'att_first_col',
        attendanceColumn: 'att_attendance_col', sourceColumn: 'att_source_col', roleColumn: 'att_role_col', eventLinkColumn: 'att_event_col',
        attendeeLinkColumn: 'att_person_col', classDateColumn: 'att_class_date_col', classDayColumn: 'att_class_day_col',
        classLocationColumn: 'att_class_loc_col', registrantsLinkColumn: 'att_registrants_col',
        homeZipColumn: 'att_zip_col',
      },
      volunteers: {
        attendeeIdColumn: 'vol_att_col', attendeeNameColumn: 'vol_name_col', attendeeEmailColumn: 'vol_email_col', jobColumn: 'vol_job_col',
        dateColumn: 'vol_date_col', statusColumn: 'vol_status_col', historicalColumn: 'vol_hist_col', volunteerLinkColumn: 'vol_person_col',
        eventColumn: 'vol_event_col', listingColumn: 'vol_listing_col', ticketTypeColumn: 'vol_ticket_col',
        attendeePhoneColumn: 'vol_phone_col',
        shiftTimeColumn: 'vol_time_col',
      },
      registrantsLinkExcludedEventIds: ['8888'],
      classEmails: { pageUrl: null, sandboxRecipient: null, timelineActivityId: null },
      peopleEmailColumn: 'people_email_col',
    },
    employerAnswers: { enabled: true },
  };
}

// An Order as the API blueprint's example shapes it, trimmed to what this Worker reads, with the
// `event` expansion. Dates are UTC timestamps; costs are Currency Cost objects.
export function testOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: '442719216',
    created: '2026-09-15T02:00:00Z',
    changed: '2026-09-15T02:00:00Z',
    name: 'Jane Rider',
    first_name: 'Jane',
    last_name: 'Rider',
    email: 'jane@example.com',
    status: 'placed',
    event_id: '17937020110',
    resource_uri: 'https://www.eventbriteapi.com/v3/orders/442719216/',
    costs: {
      base_price: { currency: 'USD', value: 4000, major_value: '40.00', display: '$40.00' },
      gross: { currency: 'USD', value: 4532, major_value: '45.32', display: '$45.32' },
      eventbrite_fee: { currency: 'USD', value: 400, major_value: '4.00', display: '$4.00' },
      payment_fee: { currency: 'USD', value: 132, major_value: '1.32', display: '$1.32' },
      tax: { currency: 'USD', value: 0, major_value: '0.00', display: '$0.00' },
    },
    event: { id: '17937020110', name: { text: 'Bike Summit 2026', html: 'Bike Summit 2026' } },
    ...overrides,
  };
}

// testConfig plus a pledge block, for the suites that exercise pledges. Event 9100 is the pledge event.
export function withPledge(config: EventbriteSyncConfig): EventbriteSyncConfig {
  return {
    ...config,
    monday: { ...config.monday, boards: { ...config.monday.boards, 'pledge-to-ride': 444 } },
    pledge: {
      nameMatch: 'Pledge to Ride',
      columns: {
        attendeeIdColumn: 'p_id', yearColumn: 'p_year', statusColumn: 'p_status', dateColumn: 'p_date', emailColumn: 'p_email',
        detailsColumn: 'p_details', zipColumn: 'p_zip', countyColumn: 'p_county', daysPledgedColumn: 'p_days', riderTypeColumn: 'p_rider',
        heardAboutColumn: 'p_heard', whoAskedColumn: 'p_who', consentColumn: 'p_consent', otherAnswersColumn: 'p_other',
      },
      zipCounty: { 'Santa Clara': ['95014'], 'San Mateo': ['94002', '94303'] },
      events: {
        '9100': {
          year: 2026,
          questions: { '11': 'zip', '12': 'daysPledged', '13': 'riderType', '14': 'heardAbout', '15': 'whoAsked', '16': 'consent' },
          ignoreQuestions: ['19'],
          choices: {
            'Multiple days/Varios días ': 'Multiple days',
            'Banner/Flyer/Poster/Letrero/folleto': 'Flyer',
            'Friend/ Amigos': 'Friend',
          },
          consentValues: ['Yes/Si'],
        },
      },
    },
  };
}
