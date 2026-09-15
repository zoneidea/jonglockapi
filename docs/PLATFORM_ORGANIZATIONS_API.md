# Platform organization management

Base: `/platform` (also available beneath the configured API prefix).
Bearer platform JWT required. Selected organization IDs are accepted only by
this platform router; management/mobile tenant scoping is unchanged.

Organization routes verify the current platform account is active and has the
`organizations` menu. Superadmin/support can manage staff; ops is read-only.
Other platform roles and management/mobile tokens cannot access these routes.

## Endpoints

| Method/path relative to base | Input | data |
| --- | --- | --- |
| GET `/organizations` | Existing search/status/page/pageSize | Existing full paginated organization list |
| GET `/organizations/:organizationId` | Positive integer ID | Existing organization overview |
| GET `/organizations/:organizationId/markets` | page/pageSize | items: id, code, name, status, zoneCount, boothCount |
| GET `/organizations/:organizationId/markets/:marketId/zones` | page/pageSize | market + items: id, name, status, startDate, endDate, boothCount |
| GET `/organizations/:organizationId/markets/:marketId/booths` | page/pageSize, optional zoneId | market + items: id, code, name, status, price, zoneId, zoneName |
| GET `/organizations/:organizationId/users` | page/pageSize | canManage + items: id, name, email, role, status, lastLoginAt |
| PATCH `/organizations/:organizationId/users/:userId` | JSON `{ "status": "active" }` or `{ "status": "inactive" }` or `{ "password": "<new password>" }` | id, organizationId, status, passwordReset, existingSessionsRevoked: false |
| GET `/organizations/:organizationId/bookings` | page/pageSize, optional marketId, dateFrom/dateTo (`YYYY-MM-DD`) | items: id, publicId, name, marketId, marketName, status, createdAt, dateFrom, dateTo, totalAmount |

New list endpoints default to page 1, pageSize 20 (maximum 100). Each returns
`pagination: { page, pageSize, total, totalPages }` within the existing
`{ status, message, data }` response envelope. Empty lists return items: [].
Dates must be real calendar dates with dateFrom <= dateTo.

Zones use existing `floor_plans`; no new tables/migrations. Inactive markets,
zones, booths and staff remain visible. Deleted booths are excluded. Booths
without a zone appear under the all-zones view. User management is for staff
accounts in `admin_users`, not Gmail/mobile customer profiles.

Booking filters apply inclusively to **dates of using the booth**, not creation
timestamps. Each booking appears once if any item matches. The displayed date
range and amount describe the entire booking, not just filtered items. All
statuses, including draft, are reported; drafts do not imply booth occupancy.

Passwords follow the existing strong-password policy (10+ characters, uppercase,
digit and special character), capped at 72 UTF-8 bytes for bcrypt. Only the bcrypt
hash is persisted. No password is returned. A request must contain exactly one
action. Last active supervisor deactivation returns 409; all writes are scoped
and transactional. Missing or cross-organization entities return 404; denied
roles return 403; invalid payloads return 400.

## Intentional limitation

As requested, no shared auth/session middleware changes are included. Disabling
a staff account blocks future logins. Password reset replaces the login password.
Neither operation revokes previously issued JWTs. The UI warns before confirming.

## Logging and deployment

Existing HTTP/event logging captures calls; body key `password` is redacted by
the existing sanitizer. Mutation responses include organizationId for event-log
attribution. Scoped service logs include only actor/entity IDs and operation.
Private organization responses use Cache-Control: no-store.

Deploy backend before the platform frontend. No app, management frontend,
subscription mutation, or shared authentication changes are required.
Tests: `npm test`, `npm run lint`; platform: `npm run build` and UI smoke tests.
