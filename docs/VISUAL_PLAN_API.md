# Management market edit and Visual Plan API

All routes below are under `/api/management` (also existing `/management` alias),
require a management JWT, supervisor/admin role and assigned market access.
Organization is always taken from JWT, never from the request body.

## Market edit

PATCH `/markets/:marketId/basic` accepts JSON or multipart:
- `name`, `status` (active/inactive) retain the existing required contract.
- Optional `collectionMode` (self/system), `openDays` (nonempty array of weekday
  codes sun..sat; JSON string in multipart), and file `mainImage`.
- Omitted optional fields retain saved values. Other profile/contact fields remain
  untouched. Invalid payloads reject the update. New image files are removed on
  validation/transaction failure; previous image is cleaned up after commit.
- Response includes changed collectionMode/openDays/mainImageUrl when provided.
- The management market edit modal sends these fields through FormData and reuses
  the Add Market collection/day controls. Existing public cache invalidation applies.

## Existing Visual Plan routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /markets/:marketId/layouts | List active layouts |
| POST | /markets/:marketId/layouts | Create a draft |
| GET | /markets/:marketId/layouts/:layoutId | Detail and layoutJson |
| PATCH | /markets/:marketId/layouts/:layoutId | Save metadata/grid/objects |
| POST | /markets/:marketId/layouts/:layoutId/publish | Publish |
| DELETE | /markets/:marketId/layouts/:layoutId | Soft delete |

Create payload: name, description?, floorPlanId (required for new drafts), rowsCount,
columnsCount, cellSize. Each referenced floor plan may have only one non-deleted
layout. Market and floor-plan ownership are checked in a transaction. Creation
locks the tenant market before checking an active duplicate using a current locking
read, so concurrent calls through this API serialize. A duplicate returns HTTP 409.
Existing duplicate/unreferenced layouts are retained for administrator review;
existing legacy layout editing remains supported. No database migration required.

DELETE retains the row/layout_json and changes is_active to 0, status to archived,
and updated_by to the current administrator. Deleted rows disappear from lists,
details, edits and publishing; deleting again returns 404. Booths, floor plans and
booking/payment records are not deleted. A deleted reference becomes available for
creation again. The list page provides Delete with confirmation and API failure
Alerts, and creation only offers references not already in use.

The active frontend entry is `VisualPlanPage_New.jsx`, exported by Markets/index.js.
`VisualPlanPage.jsx` is an older implementation and is not the active page.
These are management APIs; this change does not add a customer/mobile visual-map
endpoint or change the mobile booth booking flow. Existing request/activity logging
and public-cache invalidation are retained.

## Production rollout — 2026-11-06

Backend 7770f05 pulled through Plesk and api.jonglock.com restarted. Frontend
67709fd built locally and on server, staged at
`.management-releases/market-layout-20261106`. Previous dist backed up to
`.management-releases/before-market-layout-20261106`. Staged bundles validated
before copying assets and atomically activating index; .htaccess/old assets retained.
Console reported LAYOUT_UI_ACTIVATED. No migration required.

Live QA: market edit modal shows collection radios, current image/upload and weekday
checkboxes; radio/day changes confirmed then cancelled. Visual Plan list shows two
existing layouts and Delete actions. Delete confirmation displayed retention wording
and was cancelled. New draft dropdown showed the two available booth plans and a
selection updated correctly; creation was cancelled. No production market settings
were saved, image uploaded, layout created/published/deleted during QA. Existing
layouts with no reference remain unchanged; new drafts require a booth-plan ID.
Backend suite: 110 passed, one optional MySQL integration skipped; lint passed.
Frontend production builds passed locally and on server. No native app build.
