import { describe, it, expect } from 'vitest';
import { validateConfig, volunteerBoardMode, NEW_VOLUNTEER_COLUMN_KEYS, PLACEHOLDER_COLUMN_ID } from './config';
import { testConfig, withPledge, withTracker } from './test/testConfig';

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

  it('requires employerAnswers.enabled to be a boolean', () => {
    const cfg = valid();
    delete cfg.employerAnswers;
    expect(() => validateConfig(cfg)).toThrow('employerAnswers.enabled');
    cfg.employerAnswers = { enabled: 'yes' };
    expect(() => validateConfig(cfg)).toThrow('employerAnswers.enabled');
    cfg.employerAnswers = { enabled: false };
    expect(validateConfig(cfg).employerAnswers.enabled).toBe(false);
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
    cfg.monday.boards['donations:live'] = '18437342657';
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

  describe('volunteers', () => {
    it('requires monday.boards.volunteers to be present, and a board id or null', () => {
      const cfg = valid();
      cfg.monday.boards.volunteers = null;
      for (const key of NEW_VOLUNTEER_COLUMN_KEYS) cfg.attendeeSync.volunteers[key] = PLACEHOLDER_COLUMN_ID;
      expect(() => validateConfig(cfg)).not.toThrow();
      delete cfg.monday.boards.volunteers;
      expect(() => validateConfig(cfg)).toThrow('monday.boards.volunteers');
    });

    it('requires every attendeeSync.volunteers column to be a column id string', () => {
      const cfg = valid();
      cfg.attendeeSync.volunteers.statusColumn = 7;
      expect(() => validateConfig(cfg)).toThrow('config: "attendeeSync.volunteers.statusColumn" must be a Monday column id string');
      delete cfg.attendeeSync.volunteers;
      expect(() => validateConfig(cfg)).toThrow('config: missing required key "attendeeSync.volunteers"');
    });

    it('requires attendeeSync.volunteers.ticketTypeColumn (the placeholder opts out)', () => {
      const cfg = valid();
      delete cfg.attendeeSync.volunteers.ticketTypeColumn;
      expect(() => validateConfig(cfg)).toThrow('config: "attendeeSync.volunteers.ticketTypeColumn" must be a Monday column id string');
      cfg.attendeeSync.volunteers.ticketTypeColumn = PLACEHOLDER_COLUMN_ID;
      expect(() => validateConfig(cfg)).not.toThrow();
    });

    it('requires attendeeSync.volunteers.attendeePhoneColumn (the placeholder opts out)', () => {
      const cfg = valid();
      delete cfg.attendeeSync.volunteers.attendeePhoneColumn;
      expect(() => validateConfig(cfg)).toThrow('config: "attendeeSync.volunteers.attendeePhoneColumn" must be a Monday column id string');
      cfg.attendeeSync.volunteers.attendeePhoneColumn = PLACEHOLDER_COLUMN_ID;
      expect(() => validateConfig(cfg)).not.toThrow();
    });

    it('requires attendeeSync.volunteers.shiftTimeColumn (the placeholder opts out)', () => {
      const cfg = valid();
      delete cfg.attendeeSync.volunteers.shiftTimeColumn;
      expect(() => validateConfig(cfg)).toThrow('config: "attendeeSync.volunteers.shiftTimeColumn" must be a Monday column id string');
      cfg.attendeeSync.volunteers.shiftTimeColumn = PLACEHOLDER_COLUMN_ID;
      expect(() => validateConfig(cfg)).not.toThrow();
    });

    it('accepts the placeholder in all five new columns (the pre-cutover production config)', () => {
      const cfg = valid();
      for (const key of NEW_VOLUNTEER_COLUMN_KEYS) cfg.attendeeSync.volunteers[key] = PLACEHOLDER_COLUMN_ID;
      expect(() => validateConfig(cfg)).not.toThrow();
    });

    it('rejects a half-filled set of the five new columns', () => {
      const cfg = valid();
      cfg.attendeeSync.volunteers.attendeeIdColumn = PLACEHOLDER_COLUMN_ID;
      expect(() => validateConfig(cfg)).toThrow(/half-configured/);
    });
  });

  describe('volunteerBoardMode', () => {
    const withPlaceholders = (keys: readonly string[], board: number | null = 666) => {
      const cfg = testConfig({}, { volunteers: board });
      for (const key of keys) (cfg.attendeeSync.volunteers as Record<string, string>)[key] = PLACEHOLDER_COLUMN_ID;
      return cfg;
    };

    it('is legacy when the board is set but all five new columns are the placeholder', () => {
      expect(volunteerBoardMode(withPlaceholders(NEW_VOLUNTEER_COLUMN_KEYS))).toBe('legacy');
    });

    it('is legacy when the board is null and all five new columns are the placeholder', () => {
      expect(volunteerBoardMode(withPlaceholders(NEW_VOLUNTEER_COLUMN_KEYS, null))).toBe('legacy');
    });

    it('is ready when the board is set and none of the five is the placeholder', () => {
      expect(volunteerBoardMode(testConfig())).toBe('ready');
    });

    it('throws when three are real and two are the placeholder', () => {
      expect(() => volunteerBoardMode(withPlaceholders(['eventColumn', 'listingColumn']))).toThrow(/half-configured.*eventColumn, listingColumn/);
    });

    it('throws when only one is the placeholder', () => {
      expect(() => volunteerBoardMode(withPlaceholders(['attendeeEmailColumn']))).toThrow(/half-configured/);
    });

    it('throws when the columns are real but the board is null', () => {
      expect(() => volunteerBoardMode(testConfig({}, { volunteers: null }))).toThrow(/monday\.boards\.volunteers/);
    });

    it('ignores Ticket Type: its placeholder only means the ticket class is not written (#115)', () => {
      const cfg = testConfig();
      cfg.attendeeSync.volunteers.ticketTypeColumn = PLACEHOLDER_COLUMN_ID;
      expect(volunteerBoardMode(cfg)).toBe('ready');
      expect(volunteerBoardMode(withPlaceholders(NEW_VOLUNTEER_COLUMN_KEYS))).toBe('legacy');
    });

    it('ignores Attendee Phone: its placeholder only means the phone is not written', () => {
      const cfg = testConfig();
      cfg.attendeeSync.volunteers.attendeePhoneColumn = PLACEHOLDER_COLUMN_ID;
      expect(volunteerBoardMode(cfg)).toBe('ready');
      expect(volunteerBoardMode(withPlaceholders(NEW_VOLUNTEER_COLUMN_KEYS))).toBe('legacy');
    });

    it('ignores Shift Time: its placeholder only means the time is not written', () => {
      const cfg = testConfig();
      cfg.attendeeSync.volunteers.shiftTimeColumn = PLACEHOLDER_COLUMN_ID;
      expect(volunteerBoardMode(cfg)).toBe('ready');
      expect(volunteerBoardMode(withPlaceholders(NEW_VOLUNTEER_COLUMN_KEYS))).toBe('legacy');
    });

    it('ignores the five existing production columns', () => {
      const cfg = testConfig();
      cfg.attendeeSync.volunteers.jobColumn = PLACEHOLDER_COLUMN_ID;
      expect(volunteerBoardMode(cfg)).toBe('ready');
    });
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

    it('requires homeZipColumn and rejects a non-array zipPrograms', () => {
      const cfg = valid();
      delete cfg.attendeeSync.registrations.homeZipColumn;
      expect(() => validateConfig(cfg)).toThrow('attendeeSync.registrations.homeZipColumn');
      const cfg2 = valid();
      cfg2.attendeeSync.registrations.homeZipColumn = PLACEHOLDER_COLUMN_ID;
      expect(() => validateConfig(cfg2)).not.toThrow();
      for (const bad of ['Public', undefined, [''], [7]]) {
        const c = valid();
        c.attendeeSync.zipPrograms = bad;
        expect(() => validateConfig(c)).toThrow('attendeeSync.zipPrograms');
      }
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

describe('validateConfig: pledge', () => {
  const pledged = () => JSON.parse(JSON.stringify(withPledge(testConfig()))) as Record<string, any>;
  const rejects = (mutate: (cfg: Record<string, any>) => void, message: string) => {
    const cfg = pledged();
    mutate(cfg);
    expect(() => validateConfig(cfg)).toThrow(message);
  };

  it('accepts a config with no pledge block', () => expect(() => validateConfig(valid())).not.toThrow());
  it('accepts a complete pledge block', () => expect(validateConfig(pledged()).pledge?.nameMatch).toBe('Pledge to Ride'));
  it('rejects a blank nameMatch', () => rejects((c) => { c.pledge.nameMatch = ''; }, 'pledge.nameMatch'));
  it('rejects a blank column id', () => rejects((c) => { c.pledge.columns.zipColumn = ''; }, 'pledge.columns.zipColumn'));
  it('rejects a missing pledge board', () => rejects((c) => { delete c.monday.boards['pledge-to-ride']; }, 'monday.boards.pledge-to-ride'));
  it('rejects a non-numeric event id', () => rejects((c) => { c.pledge.events.abc = c.pledge.events['9100']; }, 'pledge.events.abc'));
  it('rejects a non-numeric question id', () => rejects((c) => { c.pledge.events['9100'].questions.abc = 'zip'; }, 'pledge.events.9100.questions.abc'));
  it('rejects an unknown field', () => rejects((c) => { c.pledge.events['9100'].questions['1'] = 'shoeSize'; }, 'pledge.events.9100.questions.1'));
  it('rejects a non-integer year', () => rejects((c) => { c.pledge.events['9100'].year = '2026'; }, 'pledge.events.9100.year'));
  it('rejects a bad ignoreQuestions', () => rejects((c) => { c.pledge.events['9100'].ignoreQuestions = 'x'; }, 'pledge.events.9100.ignoreQuestions'));
  it('rejects a blank choice label', () => rejects((c) => { c.pledge.events['9100'].choices.Yes = ''; }, 'pledge.events.9100.choices'));
  it('rejects a bad consentValues', () => rejects((c) => { c.pledge.events['9100'].consentValues = [1]; }, 'pledge.events.9100.consentValues'));
  it('rejects a zip that is not 5 digits', () => rejects((c) => { c.pledge.zipCounty['San Mateo'].push('9401'); }, 'pledge.zipCounty.San Mateo'));
  it('rejects a zip under two counties', () => rejects((c) => { c.pledge.zipCounty['San Mateo'].push('95014'); }, '95014'));
  it('rejects a county named like a fallback', () => rejects((c) => { c.pledge.zipCounty.Outside = ['10001']; }, 'pledge.zipCounty.Outside'));
});

describe('attendeeSync.tracker', () => {
  const withRows = () => JSON.parse(JSON.stringify(withTracker(testConfig()))) as Record<string, any>;
  const rejects = (change: (c: Record<string, any>) => void, message: string) => {
    const cfg = withRows();
    change(cfg);
    expect(() => validateConfig(cfg)).toThrow(message);
  };

  it('accepts null and a complete tracker', () => {
    expect(() => validateConfig(valid())).not.toThrow();
    expect(() => validateConfig(withRows())).not.toThrow();
  });

  it('accepts a placeholder Grant column while the tracker is off', () => {
    const cfg = valid();
    cfg.attendeeSync.events.grantColumn = PLACEHOLDER_COLUMN_ID;
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it('rejects a missing tracker key', () => rejects((c) => { delete c.attendeeSync.tracker; }, 'attendeeSync.tracker'));
  it('rejects a placeholder Grant column when the tracker is on', () => rejects((c) => { c.attendeeSync.events.grantColumn = PLACEHOLDER_COLUMN_ID; }, 'attendeeSync.events.grantColumn'));
  it('rejects a missing column', () => rejects((c) => { delete c.attendeeSync.tracker.funderColumn; }, 'attendeeSync.tracker.funderColumn'));
  it('rejects a placeholder column', () => rejects((c) => { c.attendeeSync.tracker.dateColumn = PLACEHOLDER_COLUMN_ID; }, 'attendeeSync.tracker.dateColumn'));
  it('rejects a board id that is not an integer', () => rejects((c) => { c.attendeeSync.tracker.boardId = '777'; }, 'attendeeSync.tracker.boardId'));
  it('rejects a start date that is not a date', () => rejects((c) => { c.attendeeSync.tracker.startDate = 'soon'; }, 'attendeeSync.tracker.startDate'));
  it('rejects a Grant start date that is not a date', () => rejects((c) => { c.attendeeSync.tracker.grantStartDate = '2026-11'; }, 'attendeeSync.tracker.grantStartDate'));
  it('rejects a bad skipStatusLabels', () => rejects((c) => { c.attendeeSync.tracker.skipStatusLabels = 'Cancelled'; }, 'attendeeSync.tracker.skipStatusLabels'));
  it('rejects a bad grantByFunder', () => rejects((c) => { c.attendeeSync.tracker.grantByFunder = { VTA: '' }; }, 'attendeeSync.tracker.grantByFunder'));
});

describe('attendeeSync.zipCounty', () => {
  const rejects = (zipCounty: unknown, message: string) => {
    const cfg = valid();
    cfg.attendeeSync.zipCounty = zipCounty;
    expect(() => validateConfig(cfg)).toThrow(message);
  };

  it('accepts lists and overrides', () => {
    const cfg = valid();
    cfg.attendeeSync.zipCounty = { lists: { Alameda: ['94601'] }, overrides: { 94303: 'SMC or SCC' } };
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it('rejects a missing block', () => rejects(undefined, 'attendeeSync.zipCounty'));
  it('rejects a zip under two counties', () => rejects({ lists: { Alameda: ['94601'], Marin: ['94601'] }, overrides: {} }, '94601'));
  it('rejects a list zip that is not 5 digits', () => rejects({ lists: { Alameda: ['9460'] }, overrides: {} }, 'attendeeSync.zipCounty.lists.Alameda'));
  it('rejects an override that is not a zip to a label', () => {
    rejects({ lists: {}, overrides: { 943: 'SMC' } }, 'attendeeSync.zipCounty.overrides');
    rejects({ lists: {}, overrides: { 94303: '' } }, 'attendeeSync.zipCounty.overrides');
  });
});
