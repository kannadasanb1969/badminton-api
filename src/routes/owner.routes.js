import * as service from "../services/owner.service.js";
import * as batchService from "../services/owner-batch.service.js";
import * as availability from "../services/owner-availability.service.js";
import * as bookingService from "../services/owner-booking.service.js";
import * as bookingPayments from "../services/owner-booking-payment.service.js";
import * as memberService from "../services/owner-member.service.js";
import * as feeService from "../services/owner-fee.service.js";
import * as paymentService from "../services/owner-payment.service.js";
import * as dashboardService from "../services/owner-dashboard.service.js";
import * as reminderService from "../services/owner-reminder.service.js";
import { verifyAccessToken } from "../utils/auth-token.js";
import { errorResponse, successResponse } from "../utils/response.js";

async function readBody(request) {
  try { return await request.json(); } catch { throw new service.OwnerError("Valid JSON body required"); }
}

export async function handleOwnerRoutes(request, env) {
  try {
    const header = request.headers.get("authorization") || "";
    const auth = await verifyAccessToken(env, header.startsWith("Bearer ") ? header.slice(7) : null);
    if (!auth) return errorResponse("Authentication required", 401);
    const parts = new URL(request.url).pathname.replace(/\/$/, "").split("/").slice(3).map(decodeURIComponent);
    const method = request.method;

    if (parts[0] === "profile" && parts.length === 1) {
      if (method === "GET") return successResponse(await service.getProfile(env, auth));
      if (method === "POST") return successResponse(await service.createProfile(env, auth), 201);
    }
    if (parts[0] === "academies") {
      if (parts.length === 1 && method === "GET") return successResponse(await service.listAcademies(env, auth));
      if (parts.length === 1 && method === "POST") return successResponse(await service.createAcademy(env, auth, await readBody(request)), 201);
      if (parts.length === 2 && method === "GET") return successResponse(await service.getAcademy(env, auth, parts[1]));
      if (parts.length === 2 && method === "PATCH") return successResponse(await service.updateAcademy(env, auth, parts[1], await readBody(request)));
      if (parts.length === 3 && parts[2] === "courts" && method === "GET") return successResponse(await service.listCourts(env, auth, parts[1]));
      if (parts.length === 3 && parts[2] === "courts" && method === "POST") return successResponse(await service.createCourt(env, auth, parts[1], await readBody(request)), 201);
    }
    if (parts[0] === "batches") {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      if (parts.length === 1 && method === "GET") return successResponse(await batchService.listBatches(env, auth, query));
      if (parts.length === 1 && method === "POST") return successResponse(await batchService.createBatch(env, auth, await readBody(request)), 201);
      if (parts.length === 2 && method === "GET") return successResponse(await batchService.getBatch(env, auth, parts[1]));
      if (parts.length === 2 && method === "PATCH") return successResponse(await batchService.updateBatch(env, auth, parts[1], await readBody(request)));
      if (parts.length === 3 && parts[2] === "releases" && method === "POST") return successResponse(await availability.releaseBatch(env, auth, parts[1], await readBody(request)), 201);
      if (parts.length === 4 && parts[2] === "releases" && method === "DELETE") return successResponse(await availability.restoreBatch(env, auth, parts[1], parts[3]));
      if (parts.length === 3 && parts[2] === "fee-rates" && method === "GET") return successResponse(await feeService.getFeeRates(env, auth, parts[1]));
      if (parts.length === 3 && parts[2] === "fee-rates" && method === "POST") return successResponse(await feeService.setFeeRate(env, auth, parts[1], await readBody(request)), 201);
    }
    if (parts[0] === "monthly-fees") {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      if (parts.length === 1 && method === "GET") return successResponse(await feeService.listMonthlyFees(env, auth, query));
      if (parts.length === 2 && parts[1] !== "generate" && method === "GET") return successResponse(await paymentService.getMonthlyFee(env, auth, parts[1]));
      if (parts.length === 2 && parts[1] === "generate" && method === "POST") return successResponse(await feeService.generateMonthlyFees(env, auth, await readBody(request)));
    }
    if (parts[0] === "dashboard" && parts.length === 1 && method === "GET") {
      return successResponse(await dashboardService.getDashboard(env, auth, Object.fromEntries(new URL(request.url).searchParams)));
    }
    if (parts[0] === "reminders") {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      if (parts.length === 1 && method === "GET") return successResponse(await reminderService.listReminders(env, auth, query));
      if (parts.length === 2 && parts[1] === "eligible" && method === "GET") return successResponse(await reminderService.listEligible(env, auth, query));
      if (parts.length === 2 && parts[1] === "preview" && method === "POST") return successResponse(await reminderService.previewReminder(env, auth, await readBody(request)));
      if (parts.length === 2 && parts[1] === "send" && method === "POST") return successResponse(await reminderService.sendReminder(env, auth, await readBody(request)));
      if (parts.length === 2 && parts[1] === "send-bulk" && method === "POST") return successResponse(await reminderService.sendBulk(env, auth, await readBody(request)));
      if (parts.length === 2 && !["eligible", "preview", "send", "send-bulk"].includes(parts[1]) && method === "GET") return successResponse(await reminderService.getReminder(env, auth, parts[1]));
      // No PATCH / PUT / DELETE: reminder history is an audit trail.
    }
    if (parts[0] === "payments") {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      if (parts.length === 1 && method === "GET") return successResponse(await paymentService.listPayments(env, auth, query));
      if (parts.length === 1 && method === "POST") return successResponse(await paymentService.createPayment(env, auth, await readBody(request)), 201);
      if (parts.length === 2 && method === "GET") return successResponse(await paymentService.getPayment(env, auth, parts[1]));
      // No PATCH / PUT / DELETE: payments are immutable.
    }
    if (parts[0] === "members") {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      if (parts.length === 1 && method === "GET") return successResponse(await memberService.listMembers(env, auth, query));
      if (parts.length === 1 && method === "POST") return successResponse(await memberService.createMember(env, auth, await readBody(request)), 201);
      if (parts.length === 2 && method === "GET") return successResponse(await memberService.getMember(env, auth, parts[1]));
      if (parts.length === 2 && method === "PATCH") return successResponse(await memberService.updateMember(env, auth, parts[1], await readBody(request)));
      if (parts.length === 3 && parts[2] === "payments" && method === "GET") return successResponse(await paymentService.memberPayments(env, auth, parts[1]));
      if (parts.length === 3 && parts[2] === "credit" && method === "GET") return successResponse(await paymentService.memberCredit(env, auth, parts[1]));
      if (parts.length === 3 && parts[2] === "apply-credit" && method === "POST") return successResponse(await paymentService.applyCredit(env, auth, parts[1], await readBody(request)));
      if (parts.length === 3 && parts[2] === "memberships" && method === "GET") return successResponse(await memberService.listMemberships(env, auth, parts[1]));
      if (parts.length === 3 && parts[2] === "memberships" && method === "POST") return successResponse(await memberService.assignMembership(env, auth, parts[1], await readBody(request)), 201);
    }
    if (parts[0] === "memberships" && parts[2] === "leaves") {
      if (parts.length === 3 && method === "GET") return successResponse(await feeService.listLeaves(env, auth, parts[1]));
      if (parts.length === 3 && method === "POST") return successResponse(await feeService.addLeave(env, auth, parts[1], await readBody(request)), 201);
      if (parts.length === 4 && method === "DELETE") return successResponse(await feeService.cancelLeave(env, auth, parts[1], parts[3]));
    }
    if (parts[0] === "memberships" && parts.length === 3 && method === "POST") {
      if (parts[2] === "move") return successResponse(await memberService.moveMembership(env, auth, parts[1], await readBody(request)));
      if (parts[2] === "end") return successResponse(await memberService.endMembership(env, auth, parts[1], await readBody(request)));
    }
    if (parts[0] === "courts" && parts.length === 3 && parts[2] === "availability" && method === "GET") {
      return successResponse(await availability.getAvailability(env, auth, parts[1], Object.fromEntries(new URL(request.url).searchParams)));
    }
    if (parts[0] === "bookings") {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      if (parts.length === 1 && method === "GET") return successResponse(await bookingService.listBookings(env, auth, query));
      if (parts.length === 1 && method === "POST") return successResponse(await bookingService.createBooking(env, auth, await readBody(request)), 201);
      if (parts.length === 2 && method === "GET") return successResponse(await bookingService.getBooking(env, auth, parts[1]));
      if (parts.length === 3 && parts[2] === "payments" && method === "GET") return successResponse(await bookingPayments.listPayments(env, auth, parts[1]));
      if (parts.length === 3 && parts[2] === "payments" && method === "POST") return successResponse(await bookingPayments.recordPayment(env, auth, parts[1], await readBody(request)), 201);
      if (parts.length === 3 && parts[2] === "cancel" && method === "POST") return successResponse(await bookingService.cancelBooking(env, auth, parts[1], await request.json().catch(() => ({}))));
      // No PATCH / PUT / DELETE: bookings are cancelled, never edited in place or deleted. Booking payments are immutable too
      // (no edit / delete / reversal route); a refund policy is future scope.
    }
    if (parts[0] === "booking-payments" && parts.length === 3 && parts[2] === "receipt" && method === "GET") {
      return successResponse(await bookingPayments.getReceipt(env, auth, parts[1]));
    }
    if (parts[0] === "court-blocks") {
      const query = Object.fromEntries(new URL(request.url).searchParams);
      if (parts.length === 1 && method === "GET") return successResponse(await availability.listBlocks(env, auth, query));
      if (parts.length === 1 && method === "POST") return successResponse(await availability.createBlock(env, auth, await readBody(request)), 201);
      if (parts.length === 2 && method === "DELETE") return successResponse(await availability.cancelBlock(env, auth, parts[1]));
      // No PATCH / hard delete: blocks are cancelled, history is kept.
    }
    if (parts[0] === "courts" && parts.length === 2 && method === "PATCH") {
      return successResponse(await service.updateCourt(env, auth, parts[1], await readBody(request)));
    }
    return errorResponse("API endpoint not found", 404);
  } catch (error) {
    if (error instanceof service.OwnerError) {
      if (error.details) return Response.json({ success: false, message: error.message, conflict: error.details }, { status: error.status });
      return errorResponse(error.message, error.status);
    }
    if (error.code === "23505") return errorResponse("An active court with this name already exists in this academy", 409);
    if (error.code === "23503" || error.code === "23514") return errorResponse("Request does not satisfy database constraints", 400);
    console.error("Owner request failed", { code: error.code ?? "UNKNOWN" });
    return errorResponse("Unable to complete owner request", 500);
  }
}
