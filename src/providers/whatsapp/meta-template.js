// The approved Meta template this provider fills. The reminder engine decides WHAT the Owner is asking for (who owes what); this file only
// maps that onto the template's variables. The wording of the message itself lives in the template, which is approved inside Meta.
//
// Template contract (body, positional variables):
//   {{1}} member name                     Kumar
//   {{2}} academy name                    Emulator Test Academy
//   {{3}} pending items, ONE line         October 2026 - Morning Regular - ₹900; November 2026 - Evening Coaching - ₹1,500
//   {{4}} total pending                   ₹2,400
// Meta forbids newlines, tabs and runs of 4+ spaces inside a variable, so the item list is a single "; "-separated line.

export const TEMPLATE_VARIABLE_COUNT = 4;
const ITEMS_LIMIT = 600; // characters; keeps the rendered message comfortably inside WhatsApp's template size limits

export const cleanParameter = (value) => String(value ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();

// reminder = { memberName, academyName, lines: ["October 2026 - Morning Regular - ₹900", ...], total: "₹2,400" } (already formatted by the engine)
export function buildTemplateParameters(reminder) {
  if (!reminder || !Array.isArray(reminder.lines) || reminder.lines.length === 0) return null;
  const lines = reminder.lines.map(cleanParameter).filter(Boolean);
  let items = "";
  let used = 0;
  for (const line of lines) {
    const next = items ? `${items}; ${line}` : line;
    const remainingAfter = lines.length - used - 1;
    const suffix = remainingAfter > 0 ? ` and ${remainingAfter} more` : "";
    if (next.length + suffix.length > ITEMS_LIMIT && used > 0) break;
    items = next;
    used += 1;
  }
  if (used < lines.length) items = `${items} and ${lines.length - used} more`; // the TOTAL below is always the full exact total
  const params = [reminder.memberName, reminder.academyName, items, reminder.total].map(cleanParameter);
  return params.length === TEMPLATE_VARIABLE_COUNT && params.every(Boolean) ? params : null;
}
