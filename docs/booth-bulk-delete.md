# Delete selected booths

`DELETE /api/management/markets/:marketId/booths/bulk`

Uses the same authentication, subscription, role and market access checks as other
management booth mutations. Only supervisors and admins with market access may call it.

Request body:

```json
{ "boothIds": [1, 2, 3] }
```

Accepts 1–1000 positive integer IDs; duplicate IDs are processed once.
Organization scope comes from the authenticated token.

The response's `data` contains:

```json
{ "boothIds": [1, 2, 3], "deletedCount": 3, "status": "deleted" }
```

This is a soft delete. Already deleted booths are accepted but excluded from
`deletedCount`. The existing single-booth DELETE endpoint remains available.

After expiring stale bookings, all selected booths are checked in a transaction.
Missing IDs or IDs outside the organization/market return 404. Any non-deleted
booth with paid or in-progress bookings or active date locks causes 409. In either
case, none of the selected booths are deleted. Invalid input returns 400 through
the shared validation middleware. Public read caches are cleared after success.

The management UI currently calls the single-booth endpoint repeatedly. To use
this endpoint, send the selected IDs in one DELETE request instead.
