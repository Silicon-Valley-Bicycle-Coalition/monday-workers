// The real ical.js@2.x package (see node_modules/ical.js) DOES ship bundled types
// (dist/types/module.d.ts via its package.json "types"/"exports" field) — despite ical.js not
// having a reliable @types/ical.js on DefinitelyTyped, the package itself is typed. This ambient
// declaration intentionally shadows that real (much larger, mostly-`any`-typed) surface with a
// narrower, more precise one covering only what parseIcs.ts uses. One correction versus the
// initial draft: TimezoneService.register's argument order below is (timezone, name?), matching
// the current real signature — the library's actual runtime also still accepts the older
// (name, timezone) order via an explicit backward-compatibility swap ("TODO remove in v3"), but
// the real v2.2.1 types no longer describe that order, so code should use the current order.
declare module 'ical.js' {
  export function parse(input: string): unknown;

  export class Component {
    constructor(jCal: unknown);
    getAllSubcomponents(name: string): Component[];
    getFirstPropertyValue(name: string): unknown;
  }

  export class Time {
    toJSDate(): Date;
  }

  export class Timezone {
    constructor(component: Component);
    tzid: string;
  }

  export class Event {
    constructor(component: Component);
    uid: string;
    summary: string;
    startDate: Time;
    endDate: Time | null;
  }

  export const TimezoneService: {
    register(timezone: Timezone, name?: string): void;
  };
}
