import { describe, it, expect } from 'vitest';
import { validateConfig, PLACEHOLDER_COLUMN_ID } from './config';
import { testConfig } from './test/testConfig';

const valid = () => JSON.parse(JSON.stringify(testConfig())) as Record<string, any>;

describe('validateConfig', () => {
  it('accepts a complete config and returns it typed', () => {
    const cfg = validateConfig(valid());
    expect(cfg.eventbrite.actions).toEqual(['order.placed', 'order.updated', 'order.refunded']);
    expect(cfg.eventbriteSync.amountSource).toBe('gross');
  });

  it('accepts the shipped placeholder for orderIdColumn — the column is a prerequisite, not a config error', () => {
    const cfg = valid();
    cfg.eventbriteSync.orderIdColumn = PLACEHOLDER_COLUMN_ID;
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it('accepts null board ids (production, unconfigured until cutover)', () => {
    const cfg = valid();
    cfg.monday.boards['donations:live'] = null;
    cfg.monday.boards['people-live'] = null;
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it('rejects a non-object', () => {
    expect(() => validateConfig('nope')).toThrow('config: expected an object');
  });

  it.each(['donations:live', 'people-live'])('requires monday.boards.%s to be present', (key) => {
    const cfg = valid();
    delete cfg.monday.boards[key];
    expect(() => validateConfig(cfg)).toThrow(`monday.boards.${key}`);
  });

  it('rejects a board id that is not an integer', () => {
    const cfg = valid();
    cfg.monday.boards['donations:live'] = '18431577310';
    expect(() => validateConfig(cfg)).toThrow('must be a Monday board id number');
  });

  it('requires eventbrite.apiUrl to be the https v3 base without a trailing slash', () => {
    const cfg = valid();
    cfg.eventbrite.apiUrl = 'https://www.eventbriteapi.com/v3/';
    expect(() => validateConfig(cfg)).toThrow('eventbrite.apiUrl');
    cfg.eventbrite.apiUrl = 'http://www.eventbriteapi.com/v3';
    expect(() => validateConfig(cfg)).toThrow('eventbrite.apiUrl');
  });

  it('requires eventbrite.organizationId to be a string or null', () => {
    const cfg = valid();
    cfg.eventbrite.organizationId = 308733706151;
    expect(() => validateConfig(cfg)).toThrow('eventbrite.organizationId');
    cfg.eventbrite.organizationId = '308733706151';
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it('requires at least one well-formed webhook action', () => {
    const cfg = valid();
    cfg.eventbrite.actions = [];
    expect(() => validateConfig(cfg)).toThrow('eventbrite.actions');
    cfg.eventbrite.actions = ['order placed'];
    expect(() => validateConfig(cfg)).toThrow('eventbrite.actions');
  });

  it.each(['orderIdColumn', 'amountColumn', 'statusColumn', 'dateColumn', 'donorEmailColumn', 'donorLinkColumn'])(
    'requires eventbriteSync.%s to be a column id string',
    (key) => {
      const cfg = valid();
      cfg.eventbriteSync[key] = null;
      expect(() => validateConfig(cfg)).toThrow(`eventbriteSync.${key}`);
    }
  );

  it.each(['thankYouSentColumn', 'giftTypeColumn', 'fiscalYearColumn'])('requires eventbriteSync.%s to be present, string or null', (key) => {
    const cfg = valid();
    delete cfg.eventbriteSync[key];
    expect(() => validateConfig(cfg)).toThrow(`eventbriteSync.${key}`);
    cfg.eventbriteSync[key] = 42;
    expect(() => validateConfig(cfg)).toThrow(`eventbriteSync.${key}`);
    cfg.eventbriteSync[key] = null;
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it('requires a Gift Type label when the Gift Type column is set', () => {
    const cfg = valid();
    cfg.eventbriteSync.giftTypeColumn = 'text_col';
    cfg.eventbriteSync.giftTypeValue = '';
    expect(() => validateConfig(cfg)).toThrow('giftTypeValue');
  });

  it('restricts amountSource to gross or base_price', () => {
    const cfg = valid();
    cfg.eventbriteSync.amountSource = 'display_price';
    expect(() => validateConfig(cfg)).toThrow('amountSource');
  });

  it.each([undefined, '', 'usd', 'US$', 840])('requires currency to be an ISO 4217 code (%s rejected)', (bad) => {
    const cfg = valid();
    cfg.eventbriteSync.currency = bad;
    expect(() => validateConfig(cfg)).toThrow('currency');
  });

  it('requires skipFreeOrders to be a boolean', () => {
    const cfg = valid();
    cfg.eventbriteSync.skipFreeOrders = 'yes';
    expect(() => validateConfig(cfg)).toThrow('skipFreeOrders');
  });

  it('requires a non-empty status label map of strings', () => {
    const cfg = valid();
    cfg.eventbriteSync.statusLabelMap = {};
    expect(() => validateConfig(cfg)).toThrow('statusLabelMap');
    cfg.eventbriteSync.statusLabelMap = { placed: null };
    expect(() => validateConfig(cfg)).toThrow('statusLabelMap');
  });

  it('requires an item name template', () => {
    const cfg = valid();
    cfg.eventbriteSync.itemNameTemplate = '';
    expect(() => validateConfig(cfg)).toThrow('itemNameTemplate');
  });

  describe('attendeeSync', () => {
    it('requires registrations.attendanceColumn to be a column id string', () => {
      const cfg = valid();
      delete cfg.attendeeSync.registrations.attendanceColumn;
      expect(() => validateConfig(cfg)).toThrow('config: "attendeeSync.registrations.attendanceColumn" must be a Monday column id string');
    });

    it('requires attendeeSync and peopleEmailColumn', () => {
      const cfg = valid();
      delete cfg.attendeeSync.peopleEmailColumn;
      expect(() => validateConfig(cfg)).toThrow('attendeeSync.peopleEmailColumn');
      delete cfg.attendeeSync;
      expect(() => validateConfig(cfg)).toThrow('config: missing required key "attendeeSync"');
    });

    it('refuses a classEmails.pageUrl while sendLinkColumn is still the placeholder', () => {
      const cfg = valid();
      cfg.attendeeSync.events.sendLinkColumn = PLACEHOLDER_COLUMN_ID;
      cfg.attendeeSync.classEmails.pageUrl = null;
      expect(() => validateConfig(cfg)).not.toThrow();
      cfg.attendeeSync.classEmails.pageUrl = 'https://example.org/classes';
      expect(() => validateConfig(cfg)).toThrow('attendeeSync.events.sendLinkColumn');
    });

    it('requires classEmails.pageUrl to be an https URL or null', () => {
      const cfg = valid();
      cfg.attendeeSync.classEmails.pageUrl = null;
      expect(() => validateConfig(cfg)).not.toThrow();
      cfg.attendeeSync.classEmails.pageUrl = 'https://example.org/classes';
      expect(() => validateConfig(cfg)).not.toThrow();
      for (const bad of ['http://example.org/classes', 'example.org', '', 7, undefined]) {
        cfg.attendeeSync.classEmails.pageUrl = bad;
        expect(() => validateConfig(cfg)).toThrow('attendeeSync.classEmails.pageUrl');
      }
      delete cfg.attendeeSync.classEmails;
      expect(() => validateConfig(cfg)).toThrow('attendeeSync.classEmails');
    });

    it('requires classEmails.sandboxRecipient to be an address or null', () => {
      const cfg = valid();
      cfg.attendeeSync.classEmails.sandboxRecipient = null;
      expect(() => validateConfig(cfg)).not.toThrow();
      cfg.attendeeSync.classEmails.sandboxRecipient = 'sandbox@bikesiliconvalley.org';
      expect(() => validateConfig(cfg)).not.toThrow();
      for (const bad of ['not an address', 'a@b', '', 7, undefined]) {
        cfg.attendeeSync.classEmails.sandboxRecipient = bad;
        expect(() => validateConfig(cfg)).toThrow('attendeeSync.classEmails.sandboxRecipient');
      }
    });

    it('requires events.sendLinkColumn to be a column id string', () => {
      const cfg = valid();
      delete cfg.attendeeSync.events.sendLinkColumn;
      expect(() => validateConfig(cfg)).toThrow('attendeeSync.events.sendLinkColumn');
    });

    it('accepts null board ids for events and event-registrations, but requires the keys', () => {
      const cfg = valid();
      cfg.monday.boards['events'] = null;
      cfg.monday.boards['event-registrations'] = null;
      expect(() => validateConfig(cfg)).not.toThrow();
      delete cfg.monday.boards['events'];
      expect(() => validateConfig(cfg)).toThrow('monday.boards.events');
    });

    it('requires well-formed actions, string-to-string programByOrganizer and string volunteerPrograms', () => {
      const cfg = valid();
      cfg.attendeeSync.actions = [];
      expect(() => validateConfig(cfg)).toThrow('attendeeSync.actions');
      cfg.attendeeSync.actions = ['attendee updated'];
      expect(() => validateConfig(cfg)).toThrow('attendeeSync.actions');
      cfg.attendeeSync.actions = ['attendee.updated'];
      cfg.attendeeSync.programByOrganizer = { '123': 7 };
      expect(() => validateConfig(cfg)).toThrow('attendeeSync.programByOrganizer');
      cfg.attendeeSync.programByOrganizer = { '123': 'Volunteering' };
      cfg.attendeeSync.volunteerPrograms = 'Volunteering';
      expect(() => validateConfig(cfg)).toThrow('attendeeSync.volunteerPrograms');
    });
  });
});
