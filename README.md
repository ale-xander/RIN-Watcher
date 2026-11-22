## Manual refresh env vars (Vercel)

Set in Vercel project settings → Environment Variables
(Production + Preview):

- `FETCH_TOKEN` — Bearer token for the Fly `/api/admin/fetch` endpoint
- `FETCH_API_URL` — Base URL of the Fly API (e.g. `https://rin-watch-api-alex.fly.dev`)

Do NOT prefix with `NEXT_PUBLIC_`; the token must stay server-side.
