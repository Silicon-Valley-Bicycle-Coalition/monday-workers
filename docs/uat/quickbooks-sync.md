# UAT script: QuickBooks sync

**Status 2026-10-28: postponed indefinitely — nothing to test.** SVBC decided not to ship this
integration at migration. Invoices stay in QuickBooks Online by hand, as in the "Requesting an
Invoice in Monday" protocol.

## What it will do

Keep QuickBooks and Monday in step in both directions: customers, invoices, and products each
get a board, and a change on either side shows up on the other. It is a post-migration
integration, not part of the cutover.

## Where it stands

The sandbox copy is deployed and its three boards exist in the CRM Sandbox workspace:
[QuickBooks Customers (sandbox)](https://bikesiliconvalley.monday.com/boards/18433278706),
[QuickBooks Invoices (sandbox)](https://bikesiliconvalley.monday.com/boards/18433278710), and
[QuickBooks Products (sandbox)](https://bikesiliconvalley.monday.com/boards/18433278721). They are
empty. The integration can't do anything until SVBC's QuickBooks side is set up: an Intuit
sandbox company, development keys, and a one-time sign-in that seeds its access token. Those are
staff prerequisites, listed in the production deploy checklist.

**Adding an item to any of these boards today does nothing.** That is not a bug.

## When it becomes testable

This script will gain Try-it steps for: creating a customer on the board and finding it in
QuickBooks, editing an invoice in QuickBooks and seeing the board update, and the product
catalogue mirror. Watch the status table in the [README](README.md).

---

*Engineers: [`quickbooks-sync/README.md`](../../quickbooks-sync/README.md) has the Intuit
app-review resolution and the sandbox provisioning record.*
