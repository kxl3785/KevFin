# Task: Update IRS contribution limits

Keep the forecast page's "max contribution" buttons current by adding the latest
published IRS limits to the lookup table. This prompt is agent-agnostic — any AI
coding agent (or a person) can execute it.

## File

`client/src/pages/Forecast.tsx` — edit the `IRS_LIMITS_BY_YEAR` object
(`Record<number, IrsLimits>`). Each entry has the shape
`{ k401Employee, k401Total, ira, hsaFamily }` in whole **today's dollars**.

## Steps

1. Determine the **upcoming** calendar year = current year + 1.
2. Look up the **official** IRS figures for that upcoming year. Prefer
   `irs.gov` news releases / Notices for retirement limits, and the IRS
   Revenue Procedure for HSA limits. Collect:
   - `k401Employee` — 401(k)/403(b) employee elective-deferral limit (§402(g)),
     the standard limit, **excluding** the age‑50+ catch-up.
   - `k401Total` — overall defined-contribution limit (§415(c)), employee +
     employer combined, **excluding** catch-up.
   - `ira` — Traditional/Roth IRA contribution limit (standard, no catch-up).
   - `hsaFamily` — HSA contribution limit for **family** coverage.

   Timing: IRS retirement limits are announced in late Oct/Nov; HSA limits the
   prior May. By mid-November both are normally published for the upcoming year.
   **If the retirement figures for the upcoming year are not yet published, stop
   and make no changes.**
3. If a row for that year already exists with matching values, do nothing.
   Otherwise add a new row keyed by the upcoming year, preserving the existing
   entries and chronological order.
4. Type-check (install deps first if needed, e.g. `npm --prefix client ci`):
   `client/node_modules/.bin/tsc --noEmit -p client/tsconfig.json`
5. Open a pull request. Cite the IRS source URL for **each** figure in the PR
   body.

## Constraints

- Use only official/authoritative sources for the numbers, and cite them.
- Change **only** the `IRS_LIMITS_BY_YEAR` table (and its comment if needed).
- Never guess a figure — if you cannot verify one from an authoritative source,
  leave that field alone and note it in the PR.
