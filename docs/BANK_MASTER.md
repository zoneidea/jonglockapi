# Thai bank master and gateway policy copy

Migration `057_bank_master.sql` adds global reference table `master_banks`:
`country_code`, three-character `code`, `name_th`, `name_en`, `short_name`,
`status`, `sort_order`, timestamps. It contains institution names, not customer
account data. `BankMasterInitializer` creates the schema and seeds the initial
20 institutions from `src/data/banks.th.json`; `npm run migrate` invokes it.
INSERT IGNORE makes repeated initialization safe and preserves operator edits.

Bank codes retain leading zeros. The initial set uses Thai bank transfer codes;
retired Thanachart code 065 is not offered as a new selection. Sources reviewed
5 November 2026:
- Bank of Thailand institution directory: https://www.bot.or.th/th/fi-list.html
- SCB bank-transfer code reference: https://www.scb.co.th/getmedia/b9375984-2652-4582-bfb6-a9fbb735cf00/manual-other-d02.pdf
- ReservePay bank-code contract: https://developer.reservepay.com/api/merchants/link-bank-account

## API contract

`GET /api/management/master-data/banks` requires a management JWT and
supervisor/admin role. Response `data` is an array of
`{code,countryCode,nameTh,nameEn,shortName}` for active TH banks, ordered by
sort order then code. No caller tenant ID is accepted/needed for this global
reference data. Database changes apply to subsequent requests without a frontend
hardcoded bank list.

Organization payment PUT accepts `details.bankCode` for manual transfer as well
as gateway registration. The backend resolves active codes from the master and
stores the canonical Thai name for manual transfer instead of trusting a caller
name. Invalid/inactive codes fail before new registration. Immutable existing
gateway recipients retain their code if retired; changed recipient fields remain
blocked by the existing registration rules. Unchanged legacy manual names/accounts
without a master code remain valid until the user chooses a bank, preserving data.
New/changed manual account entries must select a bank.

Frontend dropdowns show `code · name (short name)` and show existing unknown
values explicitly instead of silently selecting a different bank. Fetch failures
use Alert + retry. New gateway registration cannot be saved while the bank list
is loading/unavailable.

The gateway panel displays the three user-specified policy statements in red,
only when Gateway is selected. This change adds disclosure copy; it does not
implement fee calculation, automatic payouts, or a manual withdrawal workflow.
No live financial transaction or recipient registration is part of deployment.

Rollout: pull backend, run `npm run migrate`, restart API, then build/deploy the
management frontend. No mobile-app or native build is required. Keep existing
organization payment data encrypted; no account data is migrated by 057.

## Production rollout — 5 November 2026

Backend source `26ea329` and management source `25ce24a` were pulled in Plesk.
`npm run migrate` applied 057 and seeded the bank master successfully, then only
the API application was restarted. The bank master contains 20 initial banks.

Management production build output was staged at
`/var/www/vhosts/jonglock.com/.management-releases/banks-057-20261105` with backup
`before-banks-057-20261105` in the same private directory. Activation checked the
bank API reference and policy text in the bundle, published 12 assets while
retaining old assets, and replaced index.html by rename. `.htaccess` was retained.

Live UI verification at organization settings confirmed the manual bank dropdown
loaded all 20 names/codes (including leading zeros), and selecting Gateway showed
the three requested red numbered statements plus the recipient bank dropdown.
Only unsaved UI choices were inspected; no account information, provider
registration, withdrawal, or real payment was submitted. Native app builds were
not run. Backend tests: 101 passed, one opt-in MySQL suite skipped; management
production build and focused UI render/interaction checks passed.
