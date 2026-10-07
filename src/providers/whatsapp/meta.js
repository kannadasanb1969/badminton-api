import { metaSettings, toMetaRecipient } from "./config.js";
import { buildTemplateParameters } from "./meta-template.js";

// Meta WhatsApp Cloud API adapter (business-initiated TEMPLATE messages).
//   POST https://graph.facebook.com/{version}/{phone-number-id}/messages   Authorization: Bearer <token>
// "success" here means ONE thing: Meta accepted the request AND returned a message id. It does not mean delivered or read
// (that needs webhooks, a later phase). Every other outcome is a failure with a safe, secret-free message.
//
// Secrets: the access token lives only in `this.#token`, is sent only in the Authorization header, and is never logged, returned or
// stored. Every string that comes back from Meta is passed through redact() before it can reach a result.

const DEFAULT_TIMEOUT_MS = 10_000;

// Operator/Owner-safe wording per outcome. `retryable` is informational: a FAILED attempt always frees the day slot (Phase 8.1).
const FAILURES = {
  META_NOT_CONFIGURED: "WhatsApp (Meta) is not fully configured on the server.",
  INVALID_RECIPIENT: "This member's mobile number cannot be used for WhatsApp.",
  META_TEMPLATE_DATA_MISSING: "The reminder has nothing to send.",
  META_AUTH_FAILED: "WhatsApp rejected the server's credentials. The administrator must refresh the access token.",
  META_RATE_LIMITED: "WhatsApp is rate limiting messages. Please try again in a few minutes.",
  META_SERVER_ERROR: "WhatsApp is temporarily unavailable. Please try again shortly.",
  META_TIMEOUT: "WhatsApp did not respond in time. Please try again.",
  META_NETWORK_ERROR: "Could not reach WhatsApp. Please check the connection and try again.",
  META_MALFORMED_RESPONSE: "WhatsApp returned an unexpected response, so the message is not confirmed as sent.",
  META_RECIPIENT_NOT_ALLOWED: "This number is not allowed to receive messages from the current WhatsApp sender (for a Meta test sender, add it to the allowed recipient list).",
  META_RECIPIENT_UNREACHABLE: "This number could not be reached on WhatsApp.",
  META_TEMPLATE_NOT_FOUND: "The configured WhatsApp template was not found or is not approved for this language.",
  META_TEMPLATE_PARAMS: "The reminder does not match the configured WhatsApp template.",
  META_REQUEST_REJECTED: "WhatsApp rejected the message.",
};

// Meta error codes we recognise (https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes)
const CODE_MAP = new Map([
  [190, "META_AUTH_FAILED"], [10, "META_AUTH_FAILED"], [200, "META_AUTH_FAILED"],
  [130429, "META_RATE_LIMITED"], [131048, "META_RATE_LIMITED"], [131056, "META_RATE_LIMITED"], [4, "META_RATE_LIMITED"], [80007, "META_RATE_LIMITED"],
  [131030, "META_RECIPIENT_NOT_ALLOWED"],
  [131026, "META_RECIPIENT_UNREACHABLE"],
  [132001, "META_TEMPLATE_NOT_FOUND"],
  [132000, "META_TEMPLATE_PARAMS"], [132005, "META_TEMPLATE_PARAMS"], [132007, "META_TEMPLATE_PARAMS"], [132012, "META_TEMPLATE_PARAMS"], [132015, "META_TEMPLATE_PARAMS"], [132016, "META_TEMPLATE_PARAMS"],
]);

const fail = (code, extra = {}) => ({ success: false, provider: "meta", errorCode: code, errorMessage: FAILURES[code] ?? FAILURES.META_REQUEST_REJECTED, ...extra });

export class MetaWhatsAppProvider {
  name = "meta";
  #token;
  #settings;
  #fetch;
  #timeoutMs;

  constructor(env = {}, { fetch: fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const s = metaSettings(env);
    this.#settings = s;
    this.#token = s.values.accessToken ?? null;
    this.#fetch = fetchImpl ?? null;
    this.#timeoutMs = timeoutMs;
  }

  // Names only, never values.
  get ready() { return this.#settings.ready; }
  get missing() { return [...this.#settings.missing, ...this.#settings.invalid]; }

  // Redacts the token (exact value, "Bearer ..." and anything shaped like a Meta access token) from any text coming from outside.
  #redact(text) {
    let out = String(text ?? "");
    if (this.#token) out = out.split(this.#token).join("[redacted]");
    return out.replace(/Bearer\s+\S+/gi, "Bearer [redacted]").replace(/\bEA[A-Za-z0-9]{20,}\b/g, "[redacted]");
  }

  async sendMessage({ to, reminder } = {}) {
    if (!this.ready) return fail("META_NOT_CONFIGURED");
    const recipient = toMetaRecipient(to);
    if (!recipient) return fail("INVALID_RECIPIENT");
    const params = buildTemplateParameters(reminder);
    if (!params) return fail("META_TEMPLATE_DATA_MISSING");

    const { phoneNumberId, graphVersion, templateName, templateLanguage } = this.#settings.values;
    const url = `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`;
    const payload = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: recipient,
      type: "template",
      template: {
        name: templateName,
        language: { code: templateLanguage },
        components: [{ type: "body", parameters: params.map((text) => ({ type: "text", text })) }],
      },
    };

    const doFetch = this.#fetch ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.#token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      return error?.name === "AbortError" ? fail("META_TIMEOUT", { retryable: true }) : fail("META_NETWORK_ERROR", { retryable: true });
    }
    clearTimeout(timer);

    // Safe JSON parsing: anything that is not a JSON object is treated as malformed, never trusted.
    let body;
    try {
      const text = await response.text();
      body = text ? JSON.parse(text) : null;
    } catch {
      body = undefined;
    }
    const isObject = body !== null && typeof body === "object" && !Array.isArray(body);

    if (response.ok) {
      const id = isObject ? body.messages?.[0]?.id : null;
      // No message id = nothing we can point at: never claim it was sent.
      if (typeof id !== "string" || !id.trim() || id.length > 200) return fail("META_MALFORMED_RESPONSE");
      return { success: true, provider: "meta", providerMessageId: id };
    }

    const status = response.status;
    const metaCode = isObject && body.error && Number.isFinite(Number(body.error.code)) ? Number(body.error.code) : null;
    const detail = isObject && body.error && typeof body.error.message === "string" ? this.#redact(body.error.message).slice(0, 200) : null;
    const known = metaCode != null ? CODE_MAP.get(metaCode) : null;
    const result =
      known ? fail(known)
      : status === 401 || status === 403 ? fail("META_AUTH_FAILED")
      : status === 429 ? fail("META_RATE_LIMITED")
      : status >= 500 ? fail("META_SERVER_ERROR")
      : body === undefined ? fail("META_MALFORMED_RESPONSE")
      : fail("META_REQUEST_REJECTED");
    // Safe diagnostics for operators: the HTTP status and Meta's numeric error code (never the token, never raw headers).
    return { ...result, httpStatus: status, ...(metaCode != null ? { providerErrorCode: metaCode } : {}), ...(detail && result.errorCode === "META_REQUEST_REJECTED" ? { errorMessage: `${result.errorMessage} ${detail}` } : {}),
      retryable: status === 429 || status >= 500 || known === "META_RATE_LIMITED" };
  }
}
