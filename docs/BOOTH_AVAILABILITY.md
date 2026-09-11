# App booth availability

Applies to public GET `/floor-plans/:floorPlanId/booths`, POST
`/floor-plans/:floorPlanId/booths/availability`, POST `/booths/:boothId/availability`
and authenticated mobile GET `/markets/:marketId/booths` (under their existing API prefixes).

- Request and response fields are unchanged. Date-list POST payload remains `{ "dates": ["YYYY-MM-DD"] }`.
- Only active booths are returned. An inactive single booth returns the existing `data: null` shape.
- Locks belonging to a draft booking do not affect the displayed availability. With no other blocking lock, the date is available.
- Non-draft held/processing locks remain processing; paid locks remain booked (mobile uses its existing status names).
- Joins preserve organization and market scope. No database migration is required.
- This changes display only: draft temporary reservation locks and transaction conflict checks remain in place to prevent double booking. A displayed free booth can still return a hold conflict until an existing temporary hold expires.
- Availability responses are not master-data cached. Restart deployed API workers to load the changed handlers.
