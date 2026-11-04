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
      boards: { 'donations:live': 111, 'people-live': 42, events: 222, 'event-registrations': 333, ...boards },
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
      events: {
        eventbriteIdColumn: 'ev_id_col', dateColumn: 'ev_date_col', endColumn: 'ev_end_col', venueColumn: 'ev_venue_col',
        addressColumn: 'ev_address_col', cityColumn: 'ev_city_col', programColumn: 'ev_program_col', eventStatusColumn: 'ev_status_col',
        sourceColumn: 'ev_source_col', urlColumn: 'ev_url_col', sendLinkColumn: 'ev_send_col',
      },
      registrations: {
        attendeeIdColumn: 'att_col', attendeeNameColumn: 'att_name_col', attendeeEmailColumn: 'att_email_col', firstNameColumn: 'att_first_col',
        attendanceColumn: 'att_attendance_col', sourceColumn: 'att_source_col', roleColumn: 'att_role_col', eventLinkColumn: 'att_event_col',
        attendeeLinkColumn: 'att_person_col', classDateColumn: 'att_class_date_col', classDayColumn: 'att_class_day_col',
        classLocationColumn: 'att_class_loc_col',
      },
      classEmails: { pageUrl: null, sandboxRecipient: null },
      peopleEmailColumn: 'people_email_col',
    },
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
