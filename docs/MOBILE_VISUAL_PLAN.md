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
