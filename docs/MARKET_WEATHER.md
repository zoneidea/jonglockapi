# Market coordinates / WeatherAPI contract

Management PATCH `/api/management/markets/:marketId` accepts `latitude` (-90..90)
and `longitude` (-180..180), JSON numbers or multipart decimal strings. Both must
be provided together; two empty strings/nulls clear the point. Omitted fields
preserve existing coordinates. Existing JWT, organization and market access checks
apply. GET management markets includes nullable `latitude`, `longitude` fields.

Public GET `/api/public/markets` and `/api/public/markets/:marketId` return nullable
numeric `latitude`, `longitude`. These are public market coordinates, not personal
device locations. Migration `058_market_coordinates.sql` adds nullable columns;
existing markets remain unset until an administrator supplies a verified point.
Run `npm run migrate` before deploying clients; no coordinate backfill is guessed.
Rollback application first; keep additive columns and saved coordinates.

Management geolocation is user initiated and requires HTTPS/browser permission.
It reads the administrator's current device position, displays accuracy in an Alert,
and only persists after the normal Save action. Manual coordinate input remains
available when the administrator is offsite or permission is denied.

Mobile calls `https://api.weatherapi.com/v1/current.json` directly, per owner request:
`key=<local config>&q=<latitude>,<longitude>&lang=th&aqi=no`.
No new backend weather route, personal location permission or backend secret is used.
Requests have an 8-second timeout, concurrent request deduplication and 15-minute
per-device persistent cache. Failure retries cool down for 15 minutes; cached results
up to one hour old may show their provider timestamp. Missing location/config/data
keeps the original background and never blocks booking. Cache is per device, so
provider quota grows with active devices, not only with the number of markets.

Application maps provider condition codes to rain/cloudy first, then night, then
hot (>=35 C) or clear. These visuals represent latest area conditions, not a live
camera or guaranteed rainfall at the exact stall. Animation uses native transforms,
stops in background/unmount and respects Reduce Motion. WeatherAPI credit is visible.

Credential setup: copy `app/src/config/weather.example.ts` to `weather.local.ts`,
then set `WEATHER_API_KEY`. Local file is ignored and must be supplied separately
to each developer/build host before Metro, tests or native builds. The configured
key can be extracted from the distributed app, despite keeping it out of Git;
monitor quota and rotate as needed. Do not log request URLs, keys or provider errors.

Sources: https://www.weatherapi.com/docs/realtime-api/ and
https://www.weatherapi.com/docs/weather-icons/ . No native dependency/build required
for this feature; management web requires its normal production build/deployment.

## Production rollout — 2026-11-05

Backend e3a09f9 pulled through Plesk; migration 058 applied successfully and only
api.jonglock.com restarted. Frontend c06b4c5 built on the server into
`.management-releases/weather-058-20261105`; previous dist copied to
`.management-releases/before-weather-058-20261105`. Validated staged JS before
copying 12 assets and atomically activating index.html; existing .htaccess and old
assets retained. Live management /market-info displays both coordinate inputs and
the current-location button. No market coordinate was guessed or saved during QA.
Public markets API returned HTTP 200 and coordinate fields for all four markets;
all four remain unset and retain the normal mobile background until configured.
App 4ef960ac0 pushed; local ignored WeatherAPI credential configured. WeatherAPI
current endpoint returned HTTP 200 with Thai condition text for a public Bangkok
test coordinate. Backend tests: 103 passed, one optional MySQL integration skipped;
mobile: 44 passed; TypeScript and scoped lint passed (one preexisting warning).
Web production build passed locally and on server. No iOS/Android native build run.
Runtime animation and browser geolocation permission flow need on-device validation
after administrators save actual market coordinates.
