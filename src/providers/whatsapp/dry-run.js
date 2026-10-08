import { normalizeIndianMobile } from "./config.js";

// Test adapter. It validates its inputs and accepts the message, but makes NO network call and delivers NOTHING. Its result is flagged
// dryRun so the reminder service stores DRY_RUN and never SENT. It returns no provider message id because none exists.
export class DryRunWhatsAppProvider {
  name = "dry-run";

  async sendMessage({ from, to, body }) {
    if (!normalizeIndianMobile(from)) return { success: false, provider: this.name, errorCode: "INVALID_SENDER", errorMessage: "Sender number is not a valid mobile number" };
    if (!normalizeIndianMobile(to)) return { success: false, provider: this.name, errorCode: "INVALID_RECIPIENT", errorMessage: "Recipient number is not a valid mobile number" };
    if (typeof body !== "string" || !body.trim()) return { success: false, provider: this.name, errorCode: "EMPTY_MESSAGE", errorMessage: "Message body is empty" };
    return { success: true, dryRun: true, provider: this.name };
  }
}
