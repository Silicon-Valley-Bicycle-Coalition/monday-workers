# UAT script: the member map

**Status 2026-11-02: nothing to test yet.** The map is built but not deployed; it needs the
Cloudflare Access setup first. Once it is on `map.sandbox.bikesiliconvalley.org`, this is the
script.

This is a map for staff to see where SVBC has few members, so you can pick places for membership
drives, events and group rides. Dark-shaded neighborhoods are the gaps; a heavy outline means a
low-income neighborhood (MTC's Equity Priority Communities), so a shaded and outlined spot is a
first pick.

**You cannot break anything by testing this.** The map only reads. It never changes Monday, and
it never contacts anyone. It does show real home addresses, which is why only signed-in SVBC staff
can open it.

## How to test it

1. Open **https://map.sandbox.bikesiliconvalley.org** and sign in with your
   `@bikesiliconvalley.org` Google account. You should land on a map of San Mateo and Santa Clara
   counties with a date in the header ("Data as of ...") and, if some people couldn't be placed, a
   count such as "212 people with no usable address".
2. **Switch the shading.** Try Population gap, Warm-lead gap, Bike lane density and None. The
   colors and the legend should change each time, and only one shading shows at a time.
3. **Toggle the layers.** Equity Priority Communities (outline), Members and Warm leads, Organizations
   and Bike lanes. Members and the outline start on; the others start off.
4. **Open a neighborhood.** Click a shaded area. You should see its residents, members, warm leads
   (lapsed and never members), median household income, whether it is an Equity Priority
   Community, and the share of street miles with bike facilities.
5. **Open a member in Monday.** Zoom in, click a dot, then **Open in Monday**. The person's item
   should open on the right board. Do the same for an organization with Organizations switched on.
6. **Check a lane.** Switch Bike lanes on near a route you ride. Do the lines and classes match
   what you know?
7. **Refusal check (needs a second account).** In a private window, sign in with a Google account
   that is not `@bikesiliconvalley.org`. You should be refused and see no map and no addresses.

## What to look for

* Does the gap picture match your sense of where SVBC is thin? Name places that look wrong.
* Are low-income neighborhoods visible, or do some fade out?
* Is anything slow or cluttered enough that you would stop opening it?
* Are people in the wrong place (a dot far from their address)?

## What's not a bug

* Data is refreshed weekly (Mondays), so someone added today won't show until the next refresh.
* People with no usable address are counted in the header but have no dot.
* Bike lane miles will differ from the `svbc-bike-lanes` report; the map counts each mile once and
  clips to the county line.
* Do Not Solicit people still appear: the map is for choosing places, not contacting people.

## If something seems stuck

* **A plain "Forbidden" page?** You are not signed in with an allowed account, or Access isn't set
  up for the address yet. Tell whoever asked you to test.
* **"No snapshot yet" or an empty map?** The first refresh hasn't run. Ask an operator to start one.

Report problems on the
**[IT Requests board](https://bikesiliconvalley.monday.com/boards/8846215481)** as described in the
[UAT index](README.md#how-to-give-feedback). Never paste member addresses into a request; name the
neighborhood instead.
