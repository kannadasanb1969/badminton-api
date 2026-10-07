// Phase 9.2 pure/static tests: clock rule, validators, exact money, migration shape, route auth. No database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertNotPast, bookingAmountValue, createInput, customerMobileValue, customerNameValue, istNow } from '../src/services/owner-booking.service.js';
import { handleOwnerRoutes } from '../src/routes/owner.routes.js';

const ok = { courtId: 'c', bookingDate: '2031-05-05', startTime: '09:15', endTime: '10:45', customerName: ' Kumar  S ', customerMobile: '+91 89395-94019', bookingAmount: '1000.50' };

test('IST clock: date and time follow UTC+05:30 without day-shift bugs', () => {
  assert.deepEqual(istNow(new Date('2031-05-05T18:29:00Z')), { date: '2031-05-05', time: '23:59', minutes: 1439 });
  assert.deepEqual(istNow(new Date('2031-05-05T18:30:00Z')), { date: '2031-05-06', time: '00:00', minutes: 0 });
});

test('past rule with an injected clock: past date rejected, today only while the end is in the future', () => {
  const now = new Date('2031-05-05T04:30:00Z'); // 10:00 IST on 2031-05-05
  assert.throws(() => assertNotPast('2031-05-04', '23:00', now), /past/);
  assert.throws(() => assertNotPast('2031-05-05', '10:00', now), /already passed/); // ended exactly now
  assert.throws(() => assertNotPast('2031-05-05', '09:59', now), /already passed/);
  assert.doesNotThrow(() => assertNotPast('2031-05-05', '10:01', now)); // still running / upcoming
  assert.doesNotThrow(() => assertNotPast('2031-05-05', '24:00', now));
  assert.doesNotThrow(() => assertNotPast('2031-05-06', '00:30', now));
  // 23:30 IST is still the same IST day even though UTC says the same date; 00:30 IST next day is "tomorrow"
  assert.throws(() => assertNotPast('2031-05-05', '23:00', new Date('2031-05-05T18:31:00Z')), /past/);
});

test('input: trims, normalises mobile, keeps amount exact', () => {
  const v = createInput(ok);
  assert.deepEqual([v.customerName, v.customerMobile, v.amount, v.startTime, v.endTime], ['Kumar S', '8939594019', '1000.50', '09:15', '10:45']);
  assert.equal(customerMobileValue('8939594019'), '8939594019');
  assert.equal(customerMobileValue('918939594019'), '8939594019');
  assert.equal(customerMobileValue('08939594019'), '8939594019');
});

test('customer name and mobile are required and validated', () => {
  for (const bad of [undefined, '', '   ', 5, 'x'.repeat(101)]) assert.throws(() => customerNameValue(bad), String(bad));
  for (const bad of [undefined, null, '', '  ', '12345', '89395940190', 'abcdefghij', '+1 555 123 4567', 12345]) assert.throws(() => customerMobileValue(bad), String(bad));
  assert.throws(() => createInput({ ...ok, customerName: '' }), /name/);
  assert.throws(() => createInput({ ...ok, customerMobile: undefined }), /mobile/);
});

test('booking amount: Owner-entered, exact, zero allowed, never negative, never defaulted', () => {
  assert.equal(bookingAmountValue('0'), '0.00');
  assert.equal(bookingAmountValue('0.00'), '0.00');
  assert.equal(bookingAmountValue('1000'), '1000.00');
  assert.equal(bookingAmountValue('1000.5'), '1000.50');
  assert.equal(bookingAmountValue('0.10'), '0.10');
  assert.equal(bookingAmountValue('99999999.99'), '99999999.99');
  assert.equal(bookingAmountValue(1500), '1500.00');
  for (const bad of [undefined, null, '', '-1', '-0.01', '1.234', '1e3', 'abc', '100000000', true]) assert.throws(() => bookingAmountValue(bad), String(bad));
  assert.throws(() => createInput({ ...ok, bookingAmount: undefined }), /amount/); // no default price
});

test('time/date validation reuses the Phase 9.1 rules', () => {
  for (const [s, e] of [['09:00', '09:00'], ['10:00', '09:00'], ['23:00', '01:00'], ['9:00', '10:00']]) assert.throws(() => createInput({ ...ok, startTime: s, endTime: e }), `${s}-${e}`);
  assert.throws(() => createInput({ ...ok, bookingDate: '2031-02-30' }));
  assert.doesNotThrow(() => createInput({ ...ok, startTime: '22:00', endTime: '24:00' }));
});

test('migration is additive and Owner-domain only; service has no pricing logic', () => {
  const sql = readFileSync(new URL('../migrations/20261005_owner_bookings_phase92.sql', import.meta.url), 'utf8');
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(code, /\bDROP\s+TABLE\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bDROP\s+COLUMN\b|\bUPDATE\s+\w+\s+SET\b/i);
  assert.deepEqual([...new Set([...code.matchAll(/ALTER TABLE\s+(\w+)/gi)].map((m) => m[1]))], ['owner_bookings']);
  assert.doesNotMatch(code, /\busers\b|player_profiles|owner_members|owner_payments|owner_monthly_fees/i);
  const svc = readFileSync(new URL('../src/services/owner-booking.service.js', import.meta.url), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(svc, /per_hour|perHour|hourly|rate|discount|coupon|receipt/i); // Phase 9.3 adds only the DERIVED paymentSummary here; payment writes live in owner-booking-payment.service.js
  assert.match(svc, /lockCourtDay/); assert.match(svc, /assertWindowFree/);
});

test('unauthenticated booking routes are rejected', async () => {
  const env = { AUTH_TOKEN_SECRET: 's' };
  for (const [m, p] of [['GET', '/bookings'], ['POST', '/bookings'], ['GET', '/bookings/x'], ['POST', '/bookings/x/cancel']]) {
    assert.equal((await handleOwnerRoutes(new Request(`http://x/api/owner${p}`, { method: m }), env)).status, 401, `${m} ${p}`);
  }
});
