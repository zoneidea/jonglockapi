# Store content update — 5 November 2026

Production content was updated through the authenticated server operator session.

- Removed test markets from public discovery using the existing `softDeleteMarket` service: MKT001 (market 34, organization 36), QA Retry (31, 33), QA test (30, 32). No bookings or payments were deleted. One expired QA booking remains in history.
- Published one news article per remaining active market: ตลาดกล้วย (announcement 4), ตลาดลางเมือง (5), ตลาดสด (6), ตลาดเปิดท้าย Good Morning (7).
- Published two image banners using the markets' existing images: ตลาดกล้วย (8) and ตลาดลางเมือง (9).
- The ตลาดกล้วย article advertises **7 November 2026**, with **28 available booths**, verified immediately before publication from both active floor plans (10 + 18). The article identifies its snapshot date and tells customers to check live availability before confirming payment.

## Existing mobile API contract

`GET /api/public/announcements?type=news&limit=20` returns the news feed. `GET /api/public/announcements?type=banner&limit=6` returns carousel entries. Both keep the existing `Announcement` response fields (`id`, `organizationId`, `marketId`, `marketName`, `type`, `title`, `description`, `imageUrl`, dates). Images are existing market uploads; no credentials or PII are embedded.

The mobile carousel uses the available content width, advances every five seconds, supports manual page selection and pause, pauses in the background, and disables automatic movement for Reduce Motion. Opening a banner shows its own announcement details. Empty content no longer displays a fabricated sample banner.

## Recovery

Private snapshots are outside the web root at `/var/www/vhosts/jonglock.com/.store-content-setup/`, permissions 0700 for the directory and 0600 for JSON files. `before-2026-11-05.json` records the original market/announcement rows; `applied-2026-11-05.json` records the created announcement IDs. To revert, restore only the scoped market visibility fields and previous announcement states, then deactivate the created IDs. Do not delete booking/payment history. Restart API workers or clear their public read caches after restoring content.

No schema migration or native build is required for this data update. A store binary must include the mobile carousel source when the release is built later.
