# Customer account deletion

DELETE `/api/mobile/account` (mobile API, separate from management).

- Authorization: `Bearer <Google ID token>`; signature, audience, issuer, expiry
  and verified-email claims are checked using the existing Google verifier.
- JSON body: `{ "confirmation": true }`, strict. No client email, user ID or
  organization ID is accepted as an account selector.
- Success: existing API envelope with `data: { "deleted": true }`.
- 401 invalid/missing identity; 400 missing confirmation/unknown body fields;
  503 ACCOUNT_DELETION_NOT_CONFIGURED if Firebase Admin cleanup is unavailable.
- Idempotent; no automatic client retry. The same verified owner can retry a
  failed operation. Errors retain the local session so the user can retry.

The app restores/verifies its native Google session and checks that the Google
account matches the displayed account before sending the token. The user must
confirm a destructive Alert. On success the app revokes its Google access and
uses the existing logout flow to remove local user state and notification setup.
The Google account itself is never deleted. Email-only test entry is removed.

SQL deletion removes public profile/store details and device tokens/notifications.
Organization customer rows are anonymized and marked deleted, preserving foreign
keys for booking/payment ledgers. Identifiers, encrypted personal fields,
password credentials and consent fields are cleared/replaced. Existing customer
JWTs are rejected by the active-account check even before token expiry.
Unpaid payment rows that have not started a gateway are deleted. Their bookings
are cancelled/hidden from the cart and unpaid booth locks are released. Cleanup
locks owned bookings and payments and skips any gateway attempt/reference,
received payment, transfer evidence, fine payment or accounting document.
Gateway history, settled financial records, payouts and organizational recipient
data remain intact. Payment notification delivery links are removed before their
parent mobile notifications to respect the migration 055 foreign key.

Firebase Admin removes the owner's temporary Firestore booth locks (which contain
email/name) and any linked phone-verification Firebase Auth identity. Local
public-profile uploads referenced only by the deleted profile are removed; the
service does not fetch external URLs or remove files outside that upload directory.
Shared file references are protected. Storage/cloud failure is surfaced and SQL
changes roll back. Cloud/file deletion is irreversible and may precede a SQL
rollback; retry safely handles missing Firebase users and missing files.

Deployment: no migration required. Configure the existing Firebase Admin service
account in encrypted host Secrets before enabling the flow. The account needs
access to this app's Firebase Auth and Firestore project. Never commit that key.
The standard request/response event logger redacts Authorization and the response
contains no personal identifiers. A structured completion log contains no email.

Tests cover verified-owner-only access, strict confirmation, no email spoofing,
idempotence, cross-organization anonymization, file/cloud cleanup, preservation
of settled/gateway financial records, unstarted-payment cleanup, notification
foreign-key deletion order, transactional failures and deleted-user JWT rejection.
Do not test this endpoint against a real production customer without that
customer's explicit deletion confirmation; use disposable review accounts.
