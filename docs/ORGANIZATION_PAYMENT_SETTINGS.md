# Organization payment settings

Supersedes the market-specific settings in migration 055. All booking markets in
an organization now share one encrypted payment configuration. Only supervisors
with the existing `organization_settings` permission may manage it. Market admins
cannot change accounts used by other markets.

## API contract

Management JWT, organization identity from `req.auth.organizationId` only:

- `GET /api/management/organization-settings/payments`
- `PUT /api/management/organization-settings/payments`
- `POST /api/management/organization-settings/payments/disable` — `{confirmed:true}`
- `POST /api/management/organization-settings/payments/adopt` —
  `{sourceMarketId:33, confirmed:true}`, only for an unresolved migration conflict.

PUT remains `{mode:'manual'|'gateway',details:{...}}`; field names and multipart
`settings` / `paymentQrCodeImage` match the previous documented contract.

GET additionally includes `scope:'organization'`, `migrationConflict` and
`candidates` with only market ID/name, mode and masked account suffix. Recipient
fields remain encrypted in `details_enc` / `recipient_details_enc` using the
existing AES-256-GCM key. Request/response logging redaction remains enabled.

The previous `/markets/:marketId/payment-settings` endpoints return 410, telling
old clients to reload. The profile/VAT `/organization-settings` writer rejects
payment fields; its hidden legacy bank values cannot overwrite the new encrypted
configuration when someone saves the organization's name/contact/VAT.

Mobile booking payment-info returns `paymentSettingsScope:'organization'` and
`paymentMode` for every market. Manual mode exposes only the shared organization
transfer details; gateway mode hides transfer details; `unavailable` offers neither
channel until a migration conflict or registration issue is resolved. Backend
payment writers enforce the same choice. New checkout groups may include multiple
markets in the same organization; mixed organizations remain rejected.

## Migration / preservation

Run `npm run migrate` before restarting the API. Migration 056 adds the
`organization_payment_settings` table and preserves the old market table:

- One configured market: copy its encrypted data, contact ID, bank ID and generation.
  Retain its source market ID so retries use the original external contact identity.
- Multiple configured markets: do not select a bank automatically. Disable new
  checkout until the supervisor confirms which old configuration all markets use.
  Existing remote contacts and local market records are retained.
- No market configuration: the re-runnable `OrganizationPaymentSettingsInitializer`
  encrypts the organization's existing transfer/QR settings as the shared manual
  configuration. Newly created organizations get the same initializer on first
  management access. No gateway registration or provider mutation runs at migration.

Any processing booking in the organization blocks account/mode changes, including
migration adoption. Existing durable attempts continue reconciliation and status
notification without using the new checkout policy. No payment history is removed.
`update-bank-account` remains unimplemented; changing a registered recipient still
requires explicit gateway cancellation before a new registration.

## Rollout / verification

1. Pull backend, migrate, then restart API.
2. Build/deploy management frontend; payment settings appear only on organization
   settings, with an explicit message that all markets share the configuration.
3. Reload app JS; no native build or native dependency change required.
4. Verify two markets in one organization show the same channels/account, another
   organization is isolated, manual hides gateway, gateway hides manual, pending
   transactions stay locked, and a mixed-market/same-organization checkout works.

Rollback: retain both tables and encrypted copies, restore compatible application
versions only after reviewing the chosen organization policy. Do not drop data or
remove provider contacts to roll back the code.

## Production deployment — 5 November 2026

- Plesk pulled backend source `f25bddc` and management source `c006b1b`.
- Before migration, payment configuration was backed up with `encryptField` to
  `/var/www/vhosts/jonglock.com/.organization-payment-migration/before-1793871036425.enc`
  (private directory, file mode 0600). The snapshot contained 11 organizations
  and zero market-specific settings; there was no account-selection conflict.
- `npm run migrate` applied `056_organization_payment_settings.sql` and completed
  the initializer successfully. Only api.jonglock.com was restarted; Plesk
  confirmed the Express application was running.
- Management was built in production mode under
  `/var/www/vhosts/jonglock.com/.management-releases/organization-056-20261105`.
  Previous served files were copied to `before-org-056-20261105` in the same
  private release directory. Activation verified the organization API path,
  copied 12 assets while retaining old assets, then renamed the new index into
  place. Existing `.htaccess` was preserved.
- Live browser verification on `/organization-settings` showed the organization
  payment heading, the all-markets scope message, both payment mode choices,
  and the existing transfer QR image loaded through the new API without errors.
  No real bank details were entered and no gateway registration/cancellation
  or payment transaction was submitted during deployment.
- App source `31b2c1b27` was pushed. Native iOS/Android builds were not run.
  App verification covers TypeScript and 41 Jest checks, including mixed-market
  checkout and manual/gateway channel visibility; device/payment verification
  remains separate from this configuration deployment.
