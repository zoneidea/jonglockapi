# Audit Web — UAT rollout

16 November 2026

## Applied database changes

Target was explicitly selected as **UAT**, using the existing development connection: host `27.254.134.22`, database `zonedevn_jonglock`. Production was not modified.

The UAT migration ledger previously ended at 048. After an encrypted, verified single-transaction backup, `npm run migrate` applied pending migrations 049–062 in order. A second run completed without applying migrations again.

Verified tables: `audit_collections`, `audit_merchants`, `audit_collection_requests`. Verified columns: collection `payment_method`, `merchant_id`; request `request_hash`. Database: MariaDB 10.11; all 64 pre-migration tables were InnoDB.

Backup and encryption key are outside the repository on the operator workstation under `~/.local/share/jonglock-backups/2026-11-16T03-13-37-501Z-audit-uat/`, directory permissions 0700 and files 0600. The AES-256-GCM backup was decrypted and decompressed for verification without writing plaintext to disk. The uncompressed dump contained 2,835,684 bytes with a complete dump footer. Never copy the key or database backup into Git or the public web root.

## Server deployment still required

The owner deploys server code. Pull branch `production` of `zoneidea/jonglockapi` into the **UAT** installation, retain its UAT environment/secrets, install dependencies, run `npm run migrate` against that target and restart the existing worker. The branch name does not select a database; the server environment does.

```sh
git pull --ff-only origin production
npm ci --omit=dev
npm run migrate
```

Verify `/health`, login using a valid assigned audit account, and smoke-test markets/catalog, merchant suggestions, inspection forms, QR and collection history. Use UAT data for cash and proof approval tests.

Web deployment and LINE setup: [JongLock Audit UAT guide](https://github.com/zoneidea/jonglockaudit/blob/main/docs/UAT_DEPLOYMENT.md). Public build settings use UAT API and LIFF ID `2012624695-NgM23Vo6`; no production credentials are included.

No server worker was restarted and no LINE Console endpoint was changed from this workstation. A healthy existing public `/health` response alone does not prove that new routes are deployed.

## Recovery

Do not drop audit/payment tables to roll back a code deployment. Keep their ledger and rows, restore the previous worker version if required, and investigate compatibility. Full database restore requires a maintenance window and reconciliation of writes made after the backup; do not overwrite newer bookings or payments blindly.
