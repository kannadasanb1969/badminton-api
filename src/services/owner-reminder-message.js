import { formatRupees, fromCents, toCents } from "../utils/owner-money.js";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthName = (ymd) => `${MONTHS[Number(ymd.slice(5, 7)) - 1]} ${ymd.slice(0, 4)}`;

// One consolidated message per member. Items are oldest month first; amounts are the allocation-derived REMAINING balances (a
// part-paid fee asks only for what is left). The total is the exact sum of those balances, computed in integer cents.
// Only human text goes in: no ids, no status codes.
export function buildReminder({ memberName, academyName, items }) {
  const sorted = [...items].sort((a, b) => (a.feeMonth === b.feeMonth ? a.batchName.localeCompare(b.batchName) : a.feeMonth < b.feeMonth ? -1 : 1));
  const total = fromCents(sorted.reduce((s, i) => s + toCents(i.balance), 0n));
  const lines = sorted.map((i) => `${monthName(i.feeMonth)} - ${i.batchName} - ${formatRupees(i.balance)}`);
  const body = [
    `Hello ${memberName},`,
    "",
    `This is a fee reminder from ${academyName}.`,
    "",
    sorted.length === 1 ? "Pending fee:" : "Pending fees:",
    "",
    ...lines,
    "",
    `Total Pending: ${formatRupees(total)}`,
    "",
    "Please ignore this message if payment has already been completed recently.",
    "",
    "Thank you,",
    academyName,
  ].join("\n");
  // The same reminder as structured, already-formatted fields, for template-based providers (Meta). One source of truth: the lines and
  // the total are exactly the ones in `body`.
  const fields = { memberName, academyName, lines, total: formatRupees(total) };
  return { body, total, itemCount: sorted.length, items: sorted, fields };
}
