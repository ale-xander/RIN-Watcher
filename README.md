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

The importer is **add-only**: it inserts RINs that are not in the database yet
and stamps their `created_at`. A RIN that already exists — active *or*
inactive — is reported as a conflict and left untouched; updating a RIN is a
manual Cline/terminal job. The summary lists `Ready to Add`, every `Conflicts`
entry with its DB vs CSV data, and the `Skipped` rows (bad prefix, missing
category, duplicate in the CSV). Add `--dry-run` to see the plan without
writing anything; a real run backs up the database next to it first (pass
`--no-backup` to skip that copy).

`python backend/scripts/report_rins.py --since YYYY-MM-DD` prints the RINs
added since that date, grouped by day (default: the last 30 days).

The same flow is available to the UI as `POST /api/ops/preview` (dry run) and
`POST /api/ops/commit`, both taking the CSV as a FormData field named `file`
and requiring the `X-Admin-Token` header to match the backend's
`ADMIN_PASSWORD`.

Follow the printed 'Next steps' to push the updated DB to Fly.

## The `/lemons` upload page

`/lemons` is a hidden internal page for the same add-only import: unlock it with
the shared `ADMIN_PASSWORD`, drop a CSV, review what will be added (green),
which RINs already exist (red, DB vs CSV) and which rows were rejected (gray),
then confirm. The browser talks to Fly through the `frontend` catch-all proxy
`/api/ops/[...path]`, which forwards the file and the `X-Admin-Token` header, so
`FETCH_API_URL` must be set in Vercel (the password itself never lives there).
