// WhatsApp configuration. Everything comes from the environment (.dev.vars locally, Worker secrets when deployed). Nothing is hard-coded.
//
//   WHATSAPP_MODE                       "dry-run" (default, delivers nothing) | "meta" (real, via the Meta WhatsApp Cloud API)
//   WHATSAPP_SENDER_NUMBER              dry-run only: the sender number shown/recorded for test reminders
//
// Meta mode (all required unless noted):
//   META_WHATSAPP_ACCESS_TOKEN          SECRET. Never logged, returned or stored.
//   META_WHATSAPP_PHONE_NUMBER_ID       the sending phone number's ID (not the phone number itself)
//   META_WHATSAPP_TEMPLATE_NAME         an APPROVED fee-reminder template (see docs/owner-whatsapp-meta.md for the contract)
//   META_WHATSAPP_TEMPLATE_LANGUAGE     the template's language code, e.g. en
//   META_WHATSAPP_GRAPH_API_VERSION     e.g. v21.0
//   META_WHATSAPP_BUSINESS_ACCOUNT_ID   optional: not needed to send; reserved for template management / webhooks
//   META_WHATSAPP_DISPLAY_PHONE_NUMBER  optional: the sender number as Meta shows it, digits with country code. Display/audit only.

const INDIAN_MOBILE = /^[6-9]\d{9}$/;

// Storage form (what Owner data uses) -> 10 digits. Returns null when it is not a valid Indian mobile.
export function normalizeIndianMobile(value) {
  if (value == null) return null;
  let digits = String(value).replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return INDIAN_MOBILE.test(digits) ? digits : null;
}

// "+91XXXXXXXXXX" form used inside the engine and stored in history. Stored member mobiles are never rewritten for this.
export function toE164India(value) {
  const digits = normalizeIndianMobile(value);
  return digits ? `+91${digits}` : null;
}

// Meta wants the recipient as digits with the country code and no "+".
//   10-digit Indian mobile (India is the Owner default)     9876543210    -> 919876543210
//   already international Indian                            +919876543210 -> 919876543210
//   other numbers only when explicitly international ("+")  +14155550123  -> 14155550123
// Anything ambiguous (e.g. an 11-digit number with no "+" and no 91 prefix, or a too-short number) is rejected, never guessed.
export function toMetaRecipient(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!/^\+?[\d\s().-]+$/.test(text)) return null;
  const explicitInternational = text.startsWith("+");
  const digits = text.replace(/\D/g, "");
  const india = normalizeIndianMobile(digits);
  if (india && (digits.length === 10 || digits.length === 11 || digits.length === 12)) return `91${india}`;
  if (explicitInternational && /^[1-9]\d{7,14}$/.test(digits)) return digits;
  return null;
}

const META_VARIABLES = [
  ["META_WHATSAPP_ACCESS_TOKEN", "accessToken", /^\S{20,}$/],
  ["META_WHATSAPP_PHONE_NUMBER_ID", "phoneNumberId", /^\d{5,20}$/],
  ["META_WHATSAPP_TEMPLATE_NAME", "templateName", /^[a-z0-9_]{1,512}$/],
  ["META_WHATSAPP_TEMPLATE_LANGUAGE", "templateLanguage", /^[a-z]{2,3}(_[A-Z]{2})?$/],
  ["META_WHATSAPP_GRAPH_API_VERSION", "graphVersion", /^v\d{1,2}\.\d{1,2}$/],
];

// Internal only (contains the secret): never pass the result of this to a response, a log or a database row.
export function metaSettings(env = {}) {
  const values = {};
  const missing = [];
  const invalid = [];
  for (const [name, key, pattern] of META_VARIABLES) {
    const raw = env[name] == null ? "" : String(env[name]).trim();
    if (!raw) missing.push(name);
    else if (!pattern.test(raw)) invalid.push(name); // the VALUE is deliberately not reported
    else values[key] = raw;
  }
  return { values, missing, invalid, ready: missing.length === 0 && invalid.length === 0 };
}

function modeOf(env) {
  const raw = String(env.WHATSAPP_MODE ?? "dry-run").trim().toLowerCase().replace(/_/g, "-") || "dry-run";
  return raw;
}

export function whatsappConfig(env = {}) {
  const mode = modeOf(env);
  const dryRun = mode === "dry-run";
  const meta = mode === "meta";

  if (meta) {
    const s = metaSettings(env);
    const display = String(env.META_WHATSAPP_DISPLAY_PHONE_NUMBER ?? "").replace(/\D/g, "");
    const shown = /^[1-9]\d{7,14}$/.test(display) ? `+${display}` : null;
    const problems = [...s.missing.map((n) => `${n} (missing)`), ...s.invalid.map((n) => `${n} (invalid format)`)];
    return {
      mode, dryRun: false, meta: true, ready: s.ready, senderConfigured: s.ready,
      // The real sender is identified by the phone number ID; the number itself is only shown for the Owner's benefit.
      senderNumber: shown ?? "Meta WhatsApp sender",
      senderE164: shown ?? (s.values.phoneNumberId ? `meta:${s.values.phoneNumberId}` : null),
      realDelivery: s.ready,
      notReadyMessage: s.ready ? null : `WhatsApp (Meta) is not fully configured on the server. Set: ${problems.join(", ")}`,
    };
  }

  const sender = normalizeIndianMobile(env.WHATSAPP_SENDER_NUMBER);
  return {
    mode, dryRun, meta: false, ready: dryRun && Boolean(sender), senderConfigured: Boolean(sender),
    senderNumber: sender, senderE164: sender ? `+91${sender}` : null,
    realDelivery: false,
    notReadyMessage: dryRun ? (sender ? null : "The WhatsApp sender number is not configured") : `WhatsApp mode "${mode}" is not supported`,
  };
}

// Safe to return to the app: no secrets and no variable values, only what the Owner needs to know.
export function publicConfig(env) {
  const c = whatsappConfig(env);
  const mode = c.dryRun ? "DRY_RUN" : c.meta && c.ready ? "META" : "UNAVAILABLE";
  const modeLabel = c.dryRun
    ? "Test / dry run: no real WhatsApp message is delivered"
    : c.meta && c.ready
      ? "Live WhatsApp via Meta: messages are sent as an approved template"
      : c.meta
        ? "WhatsApp (Meta) is not fully configured: messages cannot be sent"
        : `WhatsApp mode "${c.mode}" is not supported: messages cannot be sent`;
  return {
    mode, modeLabel, senderNumber: c.senderNumber, senderConfigured: c.senderConfigured, ready: c.ready, realDelivery: c.realDelivery,
    ...(c.ready ? {} : { setupHint: c.notReadyMessage }),
  };
}
