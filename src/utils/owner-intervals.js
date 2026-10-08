// Minute-level interval math for the Owner domain (one calendar day, 00:00 - 24:00). Pure functions, no I/O.
// Times are "HH:MM" strings. "24:00" is the end-of-day marker and is valid only as an interval END.
export const DAY_START = "00:00";
export const DAY_END = "24:00";

export function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
export function fromMinutes(n) {
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
}

// Standard overlap used everywhere: a.start < b.end AND a.end > b.start. Touching ends do not overlap.
export const overlaps = (a, b) => toMinutes(a.startTime) < toMinutes(b.endTime) && toMinutes(a.endTime) > toMinutes(b.startTime);

// Merge overlapping AND adjacent intervals (06:00-07:00 + 07:00-08:00 => 06:00-08:00).
export function mergeIntervals(intervals) {
  const sorted = intervals
    .map((i) => [toMinutes(i.startTime), toMinutes(i.endTime)])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [s, e] of sorted) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }
  return merged.map(([s, e]) => ({ startTime: fromMinutes(s), endTime: fromMinutes(e) }));
}

// Free gaps of the whole calendar day after removing the (unmerged) unavailable intervals.
export function complementOfDay(unavailable) {
  const free = [];
  let cursor = 0;
  for (const u of mergeIntervals(unavailable)) {
    const s = toMinutes(u.startTime);
    if (s > cursor) free.push({ startTime: fromMinutes(cursor), endTime: fromMinutes(s) });
    cursor = toMinutes(u.endTime);
  }
  if (cursor < 1440) free.push({ startTime: fromMinutes(cursor), endTime: DAY_END });
  return free;
}
