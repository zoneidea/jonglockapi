# Market basics and soft delete

Migration required: `050_market_soft_delete.sql` adds nullable `markets.deleted_at`.
Deploy migration before starting this backend version, then deploy management UI.
No migration is run against production by the coding task itself.

## API contract (management base URL)

- `PATCH /markets/:marketId/basic`: supervisor or assigned admin.
  JSON `{ "name": "Market name", "status": "active" }` (or inactive).
  Name trimmed, 1–255 chars. Only these two fields change. Existing profile
  PATCH remains available for the full market-info form.
  Response data: `{ id, name, status }`.
- `DELETE /markets/:marketId`: supervisor only, no body.
  Response data: `{ id, deleted: true }`. No physical rows/files are removed.
- Both use JWT organization scope, reject missing/deleted/foreign markets (404),
  validate payloads (400), and preserve existing logging/mutation feedback.

Deletion locks the market and booking rows in one transaction. Any paid/refunded
booking, paid_at history, paid booking item, paid/refunded payment or live payment
intent blocks deletion (409). Draft/pending-payment/payment-processing bookings
also block deletion: cancel or let them expire first, rather than silently
cancelling a customer's checkout. Failed/expired/cancelled unpaid historical
bookings remain untouched. No cascading deletes or file removal occurs.

Successful deletion sets status=inactive and deleted_at, hides the market from
management and platform organization market lists, and invalidates the existing
public caches. Public booking already locks an active market through its join;
mobile and management creation also lock the market to serialize against delete.
Public/mobile active-market lists exclude it via inactive status. Historical
reports remain intact. No restore UI is included; database-level recovery needs
an explicit operator decision. Existing codes remain reserved.

UI: Markets list has basic edit and confirmed delete actions; success/failure
uses existing global dialogs. Refreshing the market list reconciles the selected
header market. Visual Plan retains 2D and disables 3D Interactive, including the
automatic switch after publishing. No shared authentication changes.

Checks: `npm test`, `npm run lint` in backend; `npm run build` in frontend.
