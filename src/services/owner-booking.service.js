import { withDatabase, withTransaction } from "../db/database.js";
import * as availability from "../repositories/owner-availability.repository.js";
import * as repo from "../repositories/owner-booking.repository.js";
import { MoneyError, fromCents, parseCents, toCents } from "../utils/owner-money.js";
import { toMinutes } from "../utils/owner-intervals.js";
import { assertWindowFree, dateValue, windowValue } from "./owner-availability.service.js";
import { mobileValue } from "./owner-member.service.js";
import { OwnerError, activeProfile } from "./owner.service.js";

// ---------------------------------------------------------------------------------------------------------------
// Owner-side court booking (Phase 9.2). The Owner records an already-accepted call / WhatsApp / walk-in booking, so it
// is created directly as CONFIRMED. The booking amount is whatever the Owner enters (never calculated) and is the agreed
// amount only. Manual payments are recorded separately (owner-booking-payment.service.js, Phase 9.3).
//
// Create = ONE transaction: lockCourtDay -> assertWindowFree (Phase 9.1 engine) -> INSERT. Availability shown to the
// Owner earlier is informational; this check under the lock is the only thing that prevents double booking.
// ---------------------------------------------------------------------------------------------------------------

const STATUSES = ["PENDING", "CONFIRMED", "CANCELLED"];
const VIEWS = ["upcoming", "history", "cancelled"];

// The Owner's calendar is India (UTC+05:30); there is no operational-day offset. `now` is injectable for tests.
export function istNow(now = new Date()) {
  const ist = new Date(now.getTime() + 330 * 60 * 1000).toISOString();
  return { date: ist.slice(0, 10), time: ist.slice(11, 16), minutes: Number(ist.slice(11, 13)) * 60 + Number(ist.slice(14, 16)) };
}

// Rule: a past calendar date is rejected; today is allowed only while the booking END is still in the future
// (so a booking that is already running may be recorded, but one that has fully ended may not); future dates are fine.
export function assertNotPast(date, endTime, now = new Date()) {
  const t = istNow(now);
  if (date < t.date) throw new OwnerError("Cannot book a date in the past");
  if (date === t.date && toMinutes(endTime) <= t.minutes) throw new OwnerError("That time has already passed today");
}

export function customerNameValue(v) {
  if (typeof v !== "string" || !v.trim()) throw new OwnerError("Customer name is required");
  const name = v.trim().replace(/\s+/g, " ");
  if (name.length > 100) throw new OwnerError("Customer name must be at most 100 characters");
  return name;
}
// Same canonical form as members: the 10 national digits. Required for bookings.
export function customerMobileValue(v) {
  const mobile = mobileValue(v);
  if (!mobile) throw new OwnerError("Customer mobile is required");
  return mobile;
}
// Exact money: integer cents in the app layer, numeric(10,2) in the DB. 0 is allowed (complimentary booking).
export function bookingAmountValue(v) {
  try { return fromCents(parseCents(v)); } catch (e) {
    if (e instanceof MoneyError) throw new OwnerError(`Booking amount: ${e.message}`);
    throw e;
  }
}
function reasonValue(v) {
  if (v == null || v === "") return null;
  if (typeof v !== "string") throw new OwnerError("cancellationReason must be text");
  const text = v.trim().replace(/\s+/g, " ");
  if (text.length > 200) throw new OwnerError("cancellationReason must be at most 200 characters");
  return text || null;
}

export function createInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new OwnerError("JSON object body required");
  const courtId = typeof input.courtId === "string" && input.courtId ? input.courtId : null;
  if (!courtId) throw new OwnerError("courtId is required");
  const date = dateValue(input.bookingDate, "bookingDate");
  const { startTime, endTime } = windowValue(input.startTime, input.endTime);
  return {
    courtId, date, startTime, endTime,
    customerName: customerNameValue(input.customerName), customerMobile: customerMobileValue(input.customerMobile),
    amount: bookingAmountValue(input.bookingAmount),
  };
}

const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);

// Derived from the immutable payment rows (Phase 9.3); nothing mutable is stored. A legacy Phase 9.1 booking with no amount is
// treated as 0.00 (nothing owed -> PAID).
export function paymentSummary(bookingAmount, totalPaid) {
  const amount = toCents(bookingAmount ?? "0"), paid = toCents(totalPaid ?? "0");
  return {
    bookingAmount: fromCents(amount), totalPaid: fromCents(paid), balance: fromCents(amount - paid),
    paymentStatus: paid >= amount ? "PAID" : paid > 0n ? "PARTIALLY_PAID" : "PENDING",
  };
}
export const mapBooking = (r) => ({
  id: r.id, academyId: r.academy_id, courtId: r.court_id, courtName: r.court_name, bookingDate: r.booking_date,
  startTime: r.s, endTime: r.e, customerName: r.customer_name ?? null, customerMobile: r.customer_mobile ?? null,
  bookingAmount: r.booking_amount ?? null, status: r.status, createdAt: iso(r.created_at),
  cancelledAt: iso(r.cancelled_at), cancellationReason: r.cancellation_reason ?? null,
  paymentSummary: paymentSummary(r.booking_amount, r.total_paid),
});

export async function createBooking(env, identity, input, { now = new Date() } = {}) {
  const v = createInput(input);
  assertNotPast(v.date, v.endTime, now);
  return withTransaction(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const court = await availability.lockCourtDay(db, profile.id, v.courtId, v.date); // Phase 9.1 lock
    if (!court) throw new OwnerError("Court not found", 404);
    if (court.status !== "ACTIVE") throw new OwnerError("Court is inactive", 409);
    if (court.academy_status !== "ACTIVE") throw new OwnerError("Academy is inactive", 409);
    await assertWindowFree(db, v.courtId, v.date, v.startTime, v.endTime, "This time is no longer available"); // Phase 9.1 engine
    const id = await repo.insertBooking(db, { ...v, academyId: court.academy_id, createdBy: profile.id });
    return mapBooking(await repo.findForOwner(db, profile.id, id));
  });
}

export async function listBookings(env, identity, query = {}, { now = new Date() } = {}) {
  const f = {};
  for (const key of ["academyId", "courtId"]) if (query[key]) f[key] = String(query[key]);
  for (const key of ["date", "fromDate", "toDate"]) if (query[key]) f[key] = dateValue(query[key], key);
  if (query.status) { if (!STATUSES.includes(query.status)) throw new OwnerError("status must be PENDING, CONFIRMED or CANCELLED"); f.status = query.status; }
  if (query.view) { if (!VIEWS.includes(query.view)) throw new OwnerError("view must be upcoming, history or cancelled"); f.view = query.view; }
  const t = istNow(now);
  return withDatabase(env, async (db) => {
    const profile = await activeProfile(db, identity);
    return (await repo.list(db, profile.id, f, t.date, t.time)).map(mapBooking);
  });
}

export async function getBooking(env, identity, bookingId) {
  return withDatabase(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const row = await repo.findForOwner(db, profile.id, bookingId);
    if (!row) throw new OwnerError("Booking not found", 404);
    return mapBooking(row);
  });
}

// Cancellation keeps the row (status CANCELLED + who/when/why). Repeating it is idempotent: an already-cancelled booking is
// returned unchanged (200) and its original cancellation time / reason are never overwritten.
export async function cancelBooking(env, identity, bookingId, input) {
  const reason = reasonValue(input && typeof input === "object" ? input.cancellationReason : null);
  return withTransaction(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const found = await repo.findForOwner(db, profile.id, bookingId);
    if (!found) throw new OwnerError("Booking not found", 404);
    await availability.lockCourtDay(db, profile.id, found.court_id, found.booking_date); // same lock as create / block / restore
    const current = await repo.findForOwner(db, profile.id, bookingId);
    if (current.status !== "CANCELLED") await repo.cancel(db, bookingId, profile.id, reason);
    return mapBooking(await repo.findForOwner(db, profile.id, bookingId));
  });
}
