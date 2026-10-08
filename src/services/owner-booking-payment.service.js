import { withDatabase, withTransaction } from "../db/database.js";
import * as repo from "../repositories/owner-booking-payment.repository.js";
import * as bookings from "../repositories/owner-booking.repository.js";
import { MoneyError, fromCents, parseCents, toCents } from "../utils/owner-money.js";
import { todayIST } from "../utils/owner-dates.js";
import { mapBooking, paymentSummary } from "./owner-booking.service.js";
import { dateValue } from "./owner-member.service.js";
import { OwnerError, activeProfile } from "./owner.service.js";

// ---------------------------------------------------------------------------------------------------------------
// Manual booking payments (Phase 9.3). The Owner RECORDS money already received outside the app (cash / UPI / bank transfer /
// other). No payment gateway, no UPI request, no webhook: choosing UPI only labels how the Owner says it was received.
//
// Rules
//   * payment status is DERIVED from immutable payment rows: 0 paid -> PENDING, partial -> PARTIALLY_PAID, fully paid -> PAID
//     (a 0.00 complimentary booking is PAID with no payment row; a 0.00 payment is rejected)
//   * a payment can never exceed the remaining balance; no advance / overpayment
//   * no payment on a CANCELLED booking; existing payments, receipts and history are kept when a booking is cancelled (no refund)
//   * payment date: a valid YYYY-MM-DD, today (IST) or earlier; a future date is rejected. It is bookkeeping only and never
//     drives receipt numbering (the receipt year is the IST year of recording)
//   * payments are immutable: there is no edit / delete / reversal API
//
// Record = ONE transaction. Lock order: booking row (FOR UPDATE) -> receipt counter row. Cancellation locks court-day -> booking
// row and never touches the counter, so there is no lock cycle; payment-vs-cancel serialises on the booking row.
// ---------------------------------------------------------------------------------------------------------------

export const PAYMENT_MODES = ["CASH", "UPI", "BANK_TRANSFER", "OTHER"];

function optionalText(value, label, max) {
  if (value == null) return null;
  if (typeof value !== "string") throw new OwnerError(`${label} must be text`);
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length > max) throw new OwnerError(`${label} must be at most ${max} characters`);
  return text || null;
}

// Pure + unit-tested. Amount: exact decimal text or number, > 0, at most 2 decimals, no exponent (parseCents rejects those).
export function paymentInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new OwnerError("JSON object body required");
  if (!PAYMENT_MODES.includes(input.paymentMode)) throw new OwnerError(`paymentMode must be one of ${PAYMENT_MODES.join(", ")}`);
  let amountCents;
  try { amountCents = parseCents(input.amount, { positive: true }); } catch (e) {
    if (e instanceof MoneyError) throw new OwnerError(`Payment amount: ${e.message}`);
    throw e;
  }
  return {
    amountCents, paymentMode: input.paymentMode, paymentDate: dateValue(input.paymentDate, "Payment date"),
    referenceNumber: optionalText(input.referenceNumber, "referenceNumber", 200), note: optionalText(input.note, "note", 300),
  };
}

const iso = (v) => (v instanceof Date ? v.toISOString() : v ?? null);
export const mapPayment = (r) => ({
  id: r.id, bookingId: r.booking_id, receiptNumber: r.receipt_number, amount: r.amount, paymentMode: r.payment_mode,
  paymentDate: r.payment_date, referenceNumber: r.reference_number ?? null, note: r.note ?? null, createdAt: iso(r.created_at),
  snapshot: {
    bookingAmount: r.booking_amount, paidNow: r.amount, totalPaidAfter: r.total_paid_after, balanceAfter: r.balance_after,
    paymentStatus: r.payment_status_after,
  },
});
export const mapReceipt = (r) => ({
  ...mapPayment(r),
  manuallyRecorded: true, // a record of money the Owner received outside the app, not an online payment
  academyName: r.academy_name, courtName: r.court_name, customerName: r.customer_name, customerMobile: r.customer_mobile,
  bookingDate: r.booking_date, startTime: r.s, endTime: r.e, bookingStatus: r.booking_status,
});

function translate(error) {
  if (error?.code === "23514" && /booking/.test(error.message ?? "")) return new OwnerError(error.message, 409);
  return error;
}

export async function recordPayment(env, identity, bookingId, input) {
  const v = paymentInput(input);
  try {
    return await withTransaction(env, async (db) => {
      const profile = await activeProfile(db, identity);
      if (!(await repo.lockBooking(db, profile.id, bookingId))) throw new OwnerError("Booking not found", 404);
      const booking = await bookings.findForOwner(db, profile.id, bookingId); // fresh read, after the lock
      if (booking.status === "CANCELLED") throw new OwnerError("Cannot record a payment on a cancelled booking", 409);
      const summary = paymentSummary(booking.booking_amount, booking.total_paid);
      const balance = toCents(summary.balance);
      if (balance <= 0n) throw new OwnerError("This booking is already fully paid", 409);
      if (v.amountCents > balance) throw new OwnerError(`Payment exceeds the remaining balance (${summary.balance})`, 409);

      const receiptNumber = await repo.nextReceiptNumber(db, booking.academy_id, Number(todayIST().slice(0, 4))); // counter lock last
      const id = await repo.insertPayment(db, {
        academyId: booking.academy_id, bookingId, receiptNumber, amount: fromCents(v.amountCents), paymentMode: v.paymentMode,
        paymentDate: v.paymentDate, referenceNumber: v.referenceNumber, note: v.note, userId: identity.sub,
      });
      const after = await bookings.findForOwner(db, profile.id, bookingId);
      return { payment: mapPayment(await repo.getForOwner(db, profile.id, id)), booking: mapBooking(after) };
    });
  } catch (e) { throw translate(e); }
}

export async function listPayments(env, identity, bookingId) {
  return withDatabase(env, async (db) => {
    const profile = await activeProfile(db, identity);
    const booking = await bookings.findForOwner(db, profile.id, bookingId);
    if (!booking) throw new OwnerError("Booking not found", 404);
    return { bookingId, paymentSummary: mapBooking(booking).paymentSummary, payments: (await repo.listForBooking(db, profile.id, bookingId)).map(mapPayment) };
  });
}

export async function getReceipt(env, identity, paymentId) {
  return withDatabase(env, async (db) => {
    const row = await repo.getForOwner(db, (await activeProfile(db, identity)).id, paymentId);
    if (!row) throw new OwnerError("Payment not found", 404);
    return mapReceipt(row);
  });
}
