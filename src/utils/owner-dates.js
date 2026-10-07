// Plain calendar-date helpers for the Owner domain. Dates are "YYYY-MM-DD" strings; the only timezone-aware notion is
// "today", which is the Owner's calendar day (India, UTC+05:30). No operational-day offset exists.
export const todayIST = () => new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
export const currentMonthIST = () => `${todayIST().slice(0, 7)}-01`;
const toUtc = (ymd) => new Date(`${ymd}T00:00:00Z`);
export const fmtDate = (d) => d.toISOString().slice(0, 10);
export const addDays = (ymd, n) => fmtDate(new Date(toUtc(ymd).getTime() + n * 864e5));
export const monthEnd = (monthStart) => { const d = toUtc(monthStart); return fmtDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))); };
export const parseUtcDate = toUtc;
