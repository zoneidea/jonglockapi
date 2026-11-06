# ReservePay Production configuration — 2026-11-06

Production merchant: `187407900159`.

| Platform | Installation | Provider identifier |
| --- | --- | --- |
| WEB | ins_tMTYC3Zqge | jonglock.com |
| IOS | ins_Ii6PObcOPA | th.co.zoneidea.jonglock |
| ANDROID | ins_XQ2Tgq9XHz | th.co.zoneidea |

API key and webhook verification key were saved as encrypted, write-only Plesk
Secrets for api.jonglock.com. No credential values are recorded in this document,
source, examples or mobile/web bundles. The non-secret merchant/installation IDs,
API URL and existing checkout=true setting are Plesk environment variables.
They override legacy sandbox values in the server's existing .env.

Backend 55b458d adds the optional RESERVEPAY_INSTALLATION_ID_WEB config field and
blank example; it was pulled/deployed and the API restarted. This stores the WEB
installation for future consumers; it does not add a new web checkout flow.
Mobile methods/config are fetched from the backend, so no client IDs were hardcoded
and no iOS/Android or management build was needed.

Preflight: no active creating/pending/unknown/review payment attempts; all 11
organization payment settings were manual/inactive with no registered contacts.
No existing payment history, recipient data or organization collection settings
were changed. Organizations must still select gateway and register their recipient
using the existing settings flow when they want to enable that channel.

Provider read-only verification used
[list-installations](https://developer.reservepay.com/api/merchants/list-installations)
and [list-webhooks](https://developer.reservepay.com/api/merchants/list-webhooks).
All supplied installations were enabled and identifiers matched. WEB currently
has PROMPTPAY; IOS/ANDROID expose PROMPTPAY plus KRUNGTHAI_NEXT, MAKE, SCB_EASY,
TTB_TOUCH, BBL, KMA and K_PLUS. CARD is not enabled by the provider at this cutover.
Unrelated merchant webhooks were left untouched.

Jonglock webhook whe_ZB1nAta09x is enabled, API version 2025-04-01, HMAC_SHA256,
PAYMENT_COMPLETED/PAYMENT_EXPIRED, destination:
https://api.jonglock.com/api/mobile/payments/callbacks/reservepay.
Its verification key matched the supplied key without logging the value.

Live validation: public methods endpoint returned HTTP 200 and new merchant and
platform installation IDs for IOS and ANDROID, installationEnabled=true and
checkoutEnabled=true. An unsigned empty webhook body returned 401
INVALID_WEBHOOK_SIGNATURE; the same empty body signed with the new key returned
400 INVALID_WEBHOOK_EVENT, proving signature acceptance without storing a payment
callback or settling a booking. /health returned 200. No payment, payout, bank
registration or financial transaction was performed. Seven focused protocol,
guard, route and card-form tests and backend lint passed.

Rollback before accepting live payments: restore the previous non-secret Plesk
environment and remove/replace the two new Plesk Secrets so the preserved server
.env sandbox configuration takes effect, then restart and verify both methods
endpoints. Do not roll back across live pending payments: recovery is scoped to
the configured merchant, so those must be resolved first. Do not delete history.

## Android installation correction — 2026-11-06

User replaced the initial Android installation ins_exa5BribK8 with
ins_XQ2Tgq9XHz. Provider list-installations confirmed platform ANDROID,
enabled=true and identifier th.co.zoneidea, matching the release applicationId.
Updated only RESERVEPAY_INSTALLATION_ID_ANDROID in Plesk; other IDs and Secrets
were preserved. Plesk Save/Restart initially left the serving Passenger worker
using the old ID (methods returned 503 PAYMENT_NOT_CONFIGURED). Touching the
application's tmp/restart.txt reloaded that worker. Live Android methods then
returned 200, merchant 187407900159, installation ins_XQ2Tgq9XHz,
installationEnabled=true and checkoutEnabled=true. Mobile fetches this config
from the backend; no installation ID is embedded in the Android bundle.
