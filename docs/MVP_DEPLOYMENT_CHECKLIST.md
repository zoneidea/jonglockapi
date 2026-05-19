# MVP Deployment Checklist

## Environment

- Set `NODE_ENV=production`.
- Set production `APP_URL`, `CORS_ORIGINS`, `JWT_SECRET`, and encryption keys.
- Rotate every seed/demo password before launch.
- Keep `.env` out of git and server logs.

## Database

- Take a backup before running migrations.
- Run `npm run migrate` and verify the migration completed.
- Create the first supervisor with `npm run seed:supervisor`.
- Confirm every organization has the expected subscription record.

## Security

- Confirm HTTPS is enabled for API, management, landing, and mobile clients.
- Verify session expiry redirects users to login.
- Verify password policy is enforced for admin and tenant password forms.
- Verify PII fields are encrypted and event logs are written for create, update, and delete actions.
- Confirm upload folders are writable by the app user and not executable.

## Subscription

- Confirm `/management/subscription/current` returns the active package.
- Confirm expired subscriptions block write actions and leave read-only access as designed.
- Confirm Free tier has the intended 1-year end date.

## Payments

- Use provider sandbox/test mode first.
- Verify webhook/callback signature before accepting real money.
- Reconcile paid bookings, fines, VAT, and payment callbacks.
- Keep manual payment proof upload as the fallback flow for MVP.

## Operations

- Configure access/error logs and log retention.
- Schedule database and upload backups.
- Test one restore from backup before launch.
- Monitor `/health`.

## Release Validation

```bash
npm install
npm run lint
npm test
npm run migrate
```

- Login as supervisor, admin, accounting, and audit.
- Create market, booth layout, booking, payment, fine, and report export test records.
- Verify frontend build points to the production API URL.
