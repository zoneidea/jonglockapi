# Jonglock Backend Domains

## UAT

- API host: `https://jonglockapi.zonedevnode.com`
- Public API: `https://jonglockapi.zonedevnode.com/api/public`
- Management API: `https://jonglockapi.zonedevnode.com/management` or `/api/management`
- Platform API: `https://jonglockapi.zonedevnode.com/platform` or `/api/platform`
- Allowed app origins: `https://jonglock.zonedevnode.com`, `https://jonglockmng.zonedevnode.com`

## Production

- API host: `https://api.jonglock.com`
- Public API: `https://api.jonglock.com/api/public`
- Management API: `https://api.jonglock.com/management` or `/api/management`
- Platform API: `https://api.jonglock.com/platform` or `/api/platform`
- Allowed app origins: `https://jonglock.com`, `https://management.jonglock.com`, `https://platform.jonglock.com`

## CORS

Production example:

```bash
CORS_ORIGINS=https://jonglock.com,https://management.jonglock.com,https://platform.jonglock.com
CORS_ORIGIN_SOURCE=proxy
```

Use `CORS_ORIGIN_SOURCE=proxy` on production when nginx/Plesk already injects `Access-Control-Allow-Origin`.
In this mode Express does not emit `Access-Control-Allow-Origin`; it only answers CORS methods/headers for preflight requests.
If the variable is omitted, production defaults to `proxy` and development/test defaults to `app`.

The server also allows `localhost`, `*.zonedevnode.com`, `jonglock.com`, and `*.jonglock.com` as a guarded fallback in `src/app.js`.
