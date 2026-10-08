import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { todayIST } from '../src/utils/owner-dates.js';

test('Phase 8.1 migration adds an Owner-only guard and preserves historical rows and existing index', async()=>{
  const sql=(await readFile(new URL('../migrations/20261003_owner_fee_reminder_daily_guard.sql',import.meta.url),'utf8')).replace(/--.*$/gm,'');
  assert.deepEqual([...sql.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(x=>x[1]),['owner_fee_reminder_daily_claims']);
  assert.match(sql,/PRIMARY KEY \(academy_id, member_id, reminder_date\)/);
  assert.match(sql,/ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED/);
  assert.match(sql,/LOCK TABLE owner_fee_reminders IN SHARE ROW EXCLUSIVE MODE/);
  assert.match(sql,/SELECT DISTINCT ON \(academy_id, member_id, reminder_date\)/);
  assert.match(sql,/BEFORE INSERT ON owner_fee_reminders/);
  assert.match(sql,/AFTER UPDATE ON owner_fee_reminders/);
  assert.doesNotMatch(sql,/\b(DROP|ALTER|TRUNCATE)\b|UPDATE\s+owner_fee_reminders|DELETE\s+FROM\s+owner_fee_reminders/i);
  assert.match(sql,/NEW.status = 'FAILED'[\s\S]*WHERE reminder_id = NEW.id/);
  assert.doesNotMatch(sql,/\b(users|auth_sessions|owner_monthly_fees|owner_payments)\b/);
});

test('daily reminder date changes at local IST midnight rather than UTC midnight',()=>{
  const now=Date.now;
  try{
    Date.now=()=>Date.parse('2026-10-03T18:29:59.999Z');assert.equal(todayIST(),'2026-10-03');
    Date.now=()=>Date.parse('2026-10-03T18:30:00.000Z');assert.equal(todayIST(),'2026-10-04');
  }finally{Date.now=now;}
});
