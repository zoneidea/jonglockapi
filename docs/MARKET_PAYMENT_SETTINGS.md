# Market booking payment settings and payment status delivery

## Contract

Management JWT required. Supervisor/admin only, assigned market + organization scope enforced before upload/service access.

- `GET /api/management/markets/:marketId/payment-settings`
- `PUT /api/management/markets/:marketId/payment-settings`
- `POST /api/management/markets/:marketId/payment-settings/disable` with `{ "confirmed": true }`.

PUT JSON `{ mode: "manual" | "gateway", details: {...} }`.

Manual details: `bankName`, `accountName`, `accountNumber`, `promptpayId`,
`qrCodeImageUrl`, `instructions`. Provide a bank account, PromptPay ID or QR image.
For a new QR image send multipart `settings` (the JSON object above) and
`paymentQrCodeImage` (existing image uploader restrictions). URLs must be an
existing image from this market or a server-issued upload, not a caller URL.

Gateway details: `bankCode` (3 digits), `accountName`, `accountNumber` (digits,
spaces/dashes accepted and normalized), `email`, `phone`. At least one valid
email/mobile required. No frontend-supplied tenant identity.

Response data: `mode`, `syncState`, `details`, `recipientDetails`, `contactId`,
`bankAccountId`, `errorCode`. Recipient details are decrypted only for authorized
management requests. No provider credentials are returned. Do not cache details
in browser storage.

## Provider registration

1. Persist intended recipient data encrypted locally before contacting ReservePay.
2. `retrieve-contact` using a deterministic market external ID; if missing,
   `add-contact`. Checkpoint the returned contact ID before continuing.
3. `find-bank-account` using a deterministic account external ID; if missing,
   `link-bank-account` with `primary: true` and country `TH`.
4. Enable gateway mode only when registration has completed.
5. Explicit cancellation uses `remove-contact`, then disables new gateway checkouts.
   Confirmed NOT_FOUND is safe on retry. Other provider failures remain visible
   and retryable; the market does not silently switch to a new mode.

`update-bank-account` is intentionally not implemented per the user's instruction.
Registered recipient fields are locked. Cancel gateway registration before
registering another recipient. Cancelled contacts get a new external ID generation
on reactivation. Local encrypted recipient details remain after cancellation.

Contact registration does not initiate payouts, configure automatic payouts, or
use the recipient as the payer's payment contact. Payout operations are separate.

Official references:
- https://developer.reservepay.com/api/merchants/add-contact
- https://developer.reservepay.com/api/merchants/link-bank-account
- https://developer.reservepay.com/api/merchants/remove-contact

## Compatibility and safety

Run migration `055_market_payment_settings.sql` BEFORE starting this backend.
It only adds tables. Unconfigured markets keep `legacy` behavior, including the
existing organization transfer settings and gateway availability. Nothing enables
gateway on a market automatically. Once configured, mobile booking payment-info
returns optional `paymentMode`, and the app offers only that market's channels.
The backend also rejects bypasses at gateway initiation and manual payment writes.
Checkout groups now contain bookings from one market. Existing durable attempts
remain resumable by their original idempotency key/group.

Settings changes use a bounded database lease and reject in-flight
`payment_processing` bookings. Registration checkpoints and deterministic external
IDs allow retries after lost provider responses. A failed sync cannot enable
new gateway payments. No existing payment/booking history is deleted.
The existing audit-fine payment workflow is unchanged; these settings cover
market booking payments.

`details_enc` and `recipient_details_enc` use the existing AES-256-GCM
`encryptField` helper with `FIELD_ENCRYPTION_KEY`. Keep that key for recovery
and encrypted backups. PII/account fields and multipart settings are redacted in
request/response audit logs; provider logs contain operation/status metadata only.

## Immediate status updates

Verified webhooks are stored in the durable inbox before acknowledging. A response
finish task processes the event immediately using the existing leased reconciliation
and trusted provider lookup. Cron remains the recovery path for interruptions,
provider outages, or leases held by another reconciliation.

Terminal settlement writes a `mobile_notifications` row and one unique
`payment_status_notifications` outbox row in the payment transaction. Push dispatch
runs after commit; a push failure cannot undo or fail the payment. Recovery retries
undelivered rows. FCM data contains `type: payment_status`, `attemptId`,
`paymentStatus`, `route: cart`, and the existing notification ID. No bank details.

Foreground app messages trigger an Alert and a cart reload. Duplicate notification
IDs do not repeat the Alert. Returning to foreground refreshes the cart; while a
processing row exists, it also checks the backend every 5 seconds as a fallback.
Processing rows cannot be selected, checked out, or deleted. Closing checkout
refreshes the cart so the newly created attempt is immediately locked.

FCM requires backend Firebase Admin credentials, active registered device tokens,
matching Firebase project and user notification permission. Instant delivery is
subject to push/network availability; recovery and the automatic cart checks cover
missed notifications. Simulator delivery must not substitute for physical iOS and
Android verification.

## Rollout / rollback

1. Pull backend, run `npm run migrate`, then restart only this API service.
2. Confirm existing cron recovery remains active and Firebase Admin is configured.
3. Deploy management frontend and reload the app's JS bundle. No native dependency
   is introduced by this change. No app build was run per user instruction.
4. Configure one sandbox market, verify add/link, repeat save without duplicates,
   cancellation with confirmation, and retained encrypted local recipient data.
5. Test QR payment on physical iOS/Android: lock screen and reopen cart; checkout
   and delete must be unavailable. Pay, then verify Alert + cart update without
   refresh. Repeat webhook delivery must not duplicate settlement/outbox rows.

Rollback: restore the previous application versions and leave the added tables in
place. Back up settings first. Never drop payment/notification history or remove
provider contacts just to roll back code. Market configuration must be reviewed
before restoring a version that does not enforce the configured channel.
