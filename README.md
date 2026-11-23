## Manual refresh env vars (Vercel)

Set in Vercel project settings → Environment Variables
(Production + Preview):

- `FETCH_TOKEN` — Bearer token for the Fly `/api/admin/fetch` endpoint
- `FETCH_API_URL` — Base URL of the Fly API (e.g. `https://rin-watch-api-alex.fly.dev`)

Do NOT prefix with `NEXT_PUBLIC_`; the token must stay server-side.

## Adding new RINs

Create a CSV with columns: `RIN`, `Tariff`, `Enrollment Code`, `Category`
(valid categories: ag, non_res, resid, other).

Run `python backend/scripts/manage_rins.py path/to/file.csv`.

The importer is additive: it inserts new RINs and updates `tariff`,
`enrollment_codes` and `category` on existing ones. It never deletes or
soft-deletes a RIN that is missing from the file. Add `--dry-run` to see the
plan without writing anything; a real run backs up the database next to it
first (pass `--no-backup` to skip that copy).

Follow the printed 'Next steps' to push the updated DB to Fly.
