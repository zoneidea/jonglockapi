# Market collection mode

Run `npm run migrate` to apply additive migration 059 before restarting the API or
deploying management frontend. `markets.collection_mode` is `self` or `system`,
NOT NULL, default `system`; existing markets keep their customer visibility.
The existing migration runner initializes new and existing deployments automatically.
Rollback code first and retain this additive column/data.

Management POST `/api/management/markets` (supervisor JWT, existing tenant/quota rules)
accepts multipart/JSON `collectionMode: "self" | "system"`. Omission defaults to
`system`; invalid values are rejected. Create response includes `collectionMode`.
GET management `/markets` includes `collection_mode`; both types stay manageable.
The Add Market modal has the heading "การเก็บเงิน" and radio choices "เก็บเงินเอง"
and "ชำระผ่านระบบ". This release adds selection on creation, not mode changes for
existing markets with booking/payment history.

Self-collection markets are excluded from customer public/mobile discovery,
market detail/deep links, floor plans, availability, accessories and new booking
holds/creation. Market-specific public news/banners are also excluded; global
announcements remain visible. Public caches are invalidated on creation as before.
Existing booking/payment history is retained, and audit/admin routes remain unchanged.
No staff app functionality is added in this phase.

Collection mode is independent of organization payment settings (`manual`/`gateway`).
System collection still follows the organization's configured payment channels;
this does not register/unregister ReservePay recipients or alter financial history.
Request/response/activity logging continues through existing event logging middleware.

## Production rollout — 2026-11-05

Backend ce9309a deployed through Plesk; migration 059 applied successfully and API
restarted. Frontend 22b976c built locally and on server. Prior dist backed up to
`.management-releases/before-collection-059-20261105`; build staged at
`.management-releases/collection-059-20261105`. New assets copied before atomic
index activation; original .htaccess and prior hashed assets retained. Live index
references `/assets/index-ClFGc9lD.js`. Live /markets shows the collection column;
Add Market modal shows both choices, defaults to system, and switching to self
updates selection correctly. No production test market was created or saved.
Public markets returned HTTP 200 (four existing markets), banner feed HTTP 200
(two existing banners). Backend suite: 104 passed, one optional MySQL integration
skipped; lint passed. Route regression tests cover multipart self/system/default,
invalid modes, supervisor-only creation, hidden detail/list/floor plans, holds denied
with existing HTTP 400 response, and global announcements retained. No native app
source changes or native build needed for this server-enforced visibility rule.
