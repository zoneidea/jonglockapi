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
