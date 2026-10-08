# Owner court booking foundation (Phase 9.1)

Owner-side only. Customers do not self-book; there is no pricing or payment here (Phase 9.2: Owner-defined amount).

## Time model
- Plain calendar day, `00:00` to end of day. Minute-level times, no fixed slots, no overnight intervals, start < end.
- Stored as Postgres `time`. An interval **end** may be `24:00` (end of day; valid for `time`). Starts are `00:00`-`23:59`.
  Batches keep `HH:MM` ends up to `23:59`; blocks/bookings/availability may end at `24:00`.
- Overlap everywhere: `new_start < existing_end AND new_end > existing_start` (touching is allowed).

## Batch calendar (`owner_batches`)
- `days_of_week smallint[]` ISO 1=Mon..7=Sun, strictly ascending (unique + normalised), non-empty. Default / legacy = `{1..7}`.
- `effective_from`, `effective_to` dates; NULL = unbounded. Legacy rows keep NULL/NULL (no dates were invented).
- New batches via the API: days default to all seven, `effectiveFrom` defaults to **today (IST)**, `effectiveTo` optional.
- Two ACTIVE batches on a court conflict only if time ranges overlap AND weekdays intersect AND effective ranges intersect.
- A batch create/edit is also rejected if it would cover a future active court block / blocking booking (honouring its own releases).

## Blocking rules (single source of truth: `owner-availability.repository.js`)
| Source | Blocks when |
|---|---|
| Batch | `ACTIVE`, weekday in `days_of_week`, date inside effective range, **no live RELEASED exception** for that date |
| Booking | `PENDING` or `CONFIRMED` (a pending hold holds the court). `CANCELLED` never blocks |
| Court block | `ACTIVE`. `CANCELLED` never blocks |

## One-day release / restore (`owner_batch_exceptions`)
- Release removes only that batch **occurrence** as a blocker; the batch, weekdays and dates are untouched. Whole occurrence only (no partial release).
- Valid only for an ACTIVE batch scheduled on that date. One live (`ACTIVE`) row per batch+date (partial unique index); restore sets `RESTORED` (history kept).
- Restore is rejected (409) while a blocking booking or active court block overlaps the batch time. Nothing is cancelled or moved automatically.

## Availability
`available = [00:00,24:00) minus merge(batches + bookings + blocks)`; adjacent/overlapping blockers are merged before taking the complement.

## Concurrency
Every write that changes a court's day calls `lockCourtDay(court, date)`: `FOR SHARE` on the court row (excludes batch writes, which take it `FOR UPDATE`)
then `pg_advisory_xact_lock(court+date)`. Same court+date serialise; other dates/courts proceed. Order is always court row then advisory lock.
Phase 9.2 booking creation must do: `lockCourtDay` -> `assertWindowFree` -> insert, in one transaction.

## API
- `GET /api/owner/courts/:courtId/availability?date=YYYY-MM-DD` -> `{date, court, unavailable[], releasedBatches[], available[]}`
- `POST /api/owner/batches/:id/releases {date, reason?}` / `DELETE /api/owner/batches/:id/releases/:date`
- `GET|POST /api/owner/court-blocks`, `DELETE /api/owner/court-blocks/:id` (cancel, not delete)
- Conflicts: `409 {message, conflict:{available:false, conflicts:[{type,startTime,endTime,label,...}]}}`,
  `type` in `REGULAR_BATCH | COACHING_BATCH | COURT_BLOCK | BOOKING`.

## Phase 9.3 — manual booking payments (no gateway)
Migration `20261006_owner_booking_payments.sql` (additive): `owner_booking_payments`, `owner_booking_receipt_counters`. Separate from Phase 6 (`owner_payments` etc. untouched).
- The Owner RECORDS money received outside the app. Modes: `CASH | UPI | BANK_TRANSFER | OTHER` (UPI is only a label). No provider, webhook or gateway exists.
- Status is derived from the immutable rows: 0 paid → `PENDING`, partial → `PARTIALLY_PAID`, fully paid → `PAID`; a 0.00 booking is `PAID` with no payment row. No overpayment/advance.
- Every payment row is its own receipt (`SPB-YYYY-NNNNNN`, per academy/year, gapless counter row; year = IST year of recording, not the payment date) and stores its transaction-time snapshot (booking amount, total paid after, balance after, status after). The DB guard trigger computes the snapshot and rejects overpayment and CANCELLED bookings; UPDATE/DELETE are blocked by trigger.
- Payment date: valid `YYYY-MM-DD`, today (IST) or earlier; future rejected; omitted = today.
- Lock order for Record Payment: booking row `FOR UPDATE` → receipt counter. Cancel: court-day lock → booking row (never the counter), so no cycle; payment-vs-cancel serialises on the booking row.
- Cancelling keeps payments/receipts (no refund, no reversal); new payments on a cancelled booking → 409.
- API: `POST|GET /api/owner/bookings/:id/payments` (history newest first), `GET /api/owner/booking-payments/:paymentId/receipt`; booking responses include `paymentSummary`. Cross-owner → 404. No PATCH/PUT/DELETE.
