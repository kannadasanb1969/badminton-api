// Exact money for the Owner domain. Amounts are handled as integer cents (BigInt); JavaScript floats are never used for
// financial totals. The database column type is numeric(10,2), which also caps amounts at 99,999,999.99.
const AMOUNT_RE = /^\d{1,8}(\.\d{1,2})?$/;

export class MoneyError extends Error {}

// Accepts a decimal string or a plain number with at most 2 decimals. Returns integer cents.
export function parseCents(value, { positive = false } = {}) {
  if (value == null || value === "" || typeof value === "boolean") throw new MoneyError("an amount is required");
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!AMOUNT_RE.test(text)) throw new MoneyError(text.startsWith("-") ? "amount cannot be negative" : "amount must be a number with at most 2 decimals");
  const cents = toCents(text);
  if (positive && cents <= 0n) throw new MoneyError("amount must be greater than zero");
  return cents;
}

// "1500", "1500.5", "1500.50" (as returned by numeric::text) -> cents
export function toCents(text) {
  const [whole, fraction = ""] = String(text).split(".");
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
}

export function fromCents(cents) {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  return `${negative ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2, "0")}`;
}

export const minCents = (a, b) => (a < b ? a : b);

// Indian digit grouping (12,34,567) on the exact decimal string; ".50" only when the amount has paise. Used for message text.
export function formatRupees(amount) {
  const [whole, fraction = ""] = String(amount).split(".");
  const head = whole.length > 3 ? whole.slice(0, -3) : "";
  const grouped = `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ",")}${head ? "," : ""}${whole.slice(-3)}`;
  const paise = /[1-9]/.test(fraction) ? `.${fraction.padEnd(2, "0")}` : "";
  return `₹${grouped}${paise}`;
}
