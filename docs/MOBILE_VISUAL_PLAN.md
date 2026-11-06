# Customer mobile Visual Plan

GET `/api/public/markets/:marketId/floor-plans/:floorPlanId/visual-plan`
uses the existing public discovery route group, positive integer IDs and standard
`{status,message,data}` envelope. Only public published metadata is returned.
Data is null if no active published layout references that exact floor plan, its
market/organization is inactive, market is deleted/self-collection, floor plan is
inactive, or legacy layout JSON is invalid. No drafts/deleted/unreferenced legacy
layouts, administrative author IDs or credentials are exposed.

Success data:
```
{id,marketId,floorPlanId,name,rowsCount,columnsCount,updatedAt,
 items:[{id,type,label,row,col,rowSpan,colSpan,boothId?}]}
```
Coordinates are one-based. Rows/columns are validated in 1..200. Only known object
types, valid bounds and active booths belonging to the exact organization/market/
floor plan are included. Saved booth labels are replaced with canonical booth codes.
Existing public metadata cache (60s) and management write invalidation apply. No
booking availability or payment state is cached in this response.

In the app's booth selection, a published matching layout enables "แผนผังเสมือน".
The native fullscreen map supports scrolling and zoom. Tapping an available booth
closes the map and opens the original BoothDetailSheet. Colors/disabled states use
the same date-specific effectiveBooths and Firestore temp locks as the list. The
existing hold/availability/payment checks remain authoritative; map positions never
determine pricing or payment success. Unpositioned booths remain in the normal list.

Map metadata loads independently and refreshes with pull-to-refresh. Null/network
failure retains the normal booth list and image preview. No migration, management
web build, new native dependencies or native build is required.

To enable, create a Visual Plan referencing the correct booth plan, place objects
and publish it in management. Old layouts with no reference are not automatically
reassigned; recreate them with an explicit reference. No production data is guessed.

## Production rollout — 2026-11-06

Backend 3bbbdc7 pulled through Plesk and only api.jonglock.com restarted. App
0902645bc pushed; no native build or management web deployment needed. TypeScript
passed; app tests 52 passed; backend tests 113 passed with one optional MySQL suite
skipped. Scoped app lint has only the preexisting markets.ts curly warning; backend
lint passed.

Live API requests returned HTTP 200/data null for all currently available booth
plans (market/floor-plan IDs 33/13, 33/12, 29/9, 28/7). None currently has a matching
active published referenced Visual Plan. Accordingly the app retains original booth
selection/image fallback until an administrator publishes a properly referenced
layout. No production layout/booking/payment data was created or reassigned during
validation. Native on-device rendering with real published data remains to be checked
after that configuration; component interaction and filtering were covered by tests.
