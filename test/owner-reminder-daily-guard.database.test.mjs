import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { getSafeDatabaseConfig } from '../scripts/db-target.mjs';
import { handleOwnerRoutes } from '../src/routes/owner.routes.js';
import { issueAccessToken } from '../src/utils/auth-token.js';
import { currentMonthIST, todayIST } from '../src/utils/owner-dates.js';
import * as reminders from '../src/services/owner-reminder.service.js';
import * as repo from '../src/repositories/owner-reminder.repository.js';

let config;
try { config = getSafeDatabaseConfig(); } catch {}
if (config && new URL(config.connectionString).hostname.split('.')[0] !== 'ep-weathered-meadow-b3ot536q') throw Error('STOP: wrong actual endpoint');
const env = config ? { HYPERDRIVE: { connectionString: config.connectionString }, CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: config.connectionString,
  AUTH_TOKEN_SECRET: 'phase81-test-secret', WHATSAPP_MODE: 'dry-run', WHATSAPP_SENDER_NUMBER: '9876500001' } : {};
const provider = (outcome = { success: true, dryRun: true }) => ({ name: 'test-only', calls: [], async sendMessage(args) { this.calls.push(args); return outcome; } });
const month = currentMonthIST();
const date = (n) => new Date(new Date(`${todayIST()}T00:00:00Z`).getTime() + (40 + n) * 864e5).toISOString().slice(0, 10);
const on = (n, p) => ({ today: () => date(n), ...(p ? { provider: p } : {}) });

test('Phase 8.1 daily guard A–X', { skip: !config && 'requires verified q2 database environment' }, async (t) => {
  // Every connection uses the checked direct q2 host. Test fixtures alone are removed at the end.
  const db = new pg.Client({ connectionString: config.connectionString }); await db.connect();
  const users = [];
  const existing = (await db.query('SELECT row_to_json(r) row FROM owner_fee_reminders r ORDER BY id')).rows;
  const tag = String(Math.floor(Math.random() * 9e7) + 1e7);
  async function api(u, method, path, body) {
    const token = await issueAccessToken(env, u);
    const r = await handleOwnerRoutes(new Request(`http://x/api/owner${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }), env);
    const payload = await r.json(); assert.ok(r.status < 300, JSON.stringify(payload)); return payload.data;
  }
  try {
    for (const suffix of ['1', '2']) users.push((await db.query("INSERT INTO users(mobile,role) VALUES($1,'PLAYER') RETURNING id,role", [`+91${tag}${suffix}`])).rows[0]);
    const [a,b] = users; const A = { sub: a.id, role: a.role }; const B = { sub: b.id, role: b.role };
    await api(a,'POST','/profile'); await api(b,'POST','/profile');
    const academy = await api(a,'POST','/academies',{ name: 'Phase81 temporary academy' });
    const otherAcademy = await api(b,'POST','/academies',{ name: 'Phase81 other academy' });
    const c1 = await api(a,'POST',`/academies/${academy.id}/courts`,{ name: 'C1' });
    const c2 = await api(a,'POST',`/academies/${academy.id}/courts`,{ name: 'C2' });
    const makeBatch = (u, acad, court, type, name, fee) => api(u,'POST','/batches',{ academyId: acad.id, courtId: court.id, type, name, startTime: '06:00',endTime: '07:00',feePerPerson: fee });
    const r1 = await makeBatch(a,academy,c1,'REGULAR','Batch A','1000.10');
    const r2 = await makeBatch(a,academy,c2,'COACHING','Batch B','2000.20');
    const createMember = (u, acad, name, mobile) => api(u,'POST','/members',{ academyId: acad.id, name, ...(mobile ? { mobile } : {}) });
    const m = await createMember(a,academy,'Daily Kumar','9100000001');
    const n = await createMember(a,academy,'Daily Member B','9100000002');
    const missing = await createMember(a,academy,'Daily missing mobile');
    const paid = await createMember(a,academy,'Daily paid','9100000003');
    const leave = await createMember(a,academy,'Daily leave','9100000004');
    const join = (u, member, batch) => api(u,'POST',`/members/${member.id}/memberships`,{ batchId:batch.id,startDate:month });
    await join(a,m,r1);await join(a,m,r2);await join(a,n,r1);await join(a,missing,r1);await join(a,paid,r1);const leaveMs = await join(a,leave,r1);
    const bc = await api(b,'POST',`/academies/${otherAcademy.id}/courts`,{ name:'B1' });
    const bb = await makeBatch(b,otherAcademy,bc,'REGULAR','B Batch','1000.10');
    const bm = await createMember(b,otherAcademy,'Daily Kumar','9100000001');await join(b,bm,bb);
    for(const [u,acad] of [[a,academy],[b,otherAcademy]]) await api(u,'POST','/monthly-fees/generate',{ academyId:acad.id,feeMonth:month });
    const q = { academyId:academy.id,scope:'MONTH',feeMonth:month };
    const all = { academyId:academy.id,scope:'ALL_OUTSTANDING' };
    const counts = async () => (await db.query('SELECT (SELECT count(*)::int FROM owner_fee_reminders WHERE academy_id=$1) history,(SELECT count(*)::int FROM owner_fee_reminder_daily_claims WHERE academy_id=$1) claims',[academy.id])).rows[0];
    const send = (member, scope, day, p) => reminders.sendReminder(env,A,{ memberId:member.id,...scope },on(day,p));
    const pairs = [
      ['A/H: MONTH then ALL; DRY_RUN holds daily slot',q,all],
      ['B/I: ALL then MONTH; SENT holds daily slot',all,q],
      ['C: Court 1 then Court 2', {...q,courtId:c1.id},{...q,courtId:c2.id}],
      ['D: REGULAR then COACHING',{...q,type:'REGULAR'},{...q,type:'COACHING'}],
      ['E: Batch A then Batch B',{...q,batchId:r1.id},{...q,batchId:r2.id}],
    ];
    for(const [i,[label,first,second]] of pairs.entries()) await t.test(label,async()=>{
      const p = provider(i===1 ? { success:true,providerMessageId:'test.SENT' } : undefined);
      const r = await send(m,first,i,p);assert.equal(r.result,i===1?'SENT':'DRY_RUN');
      const before=await counts();const s=await send(m,second,i,p);
      assert.deepEqual([s.result,s.reason,p.calls.length],['SKIPPED','ALREADY_REMINDED_TODAY',1]);assert.deepEqual(await counts(),before);
      const preview=await reminders.previewReminder(env,A,{memberId:m.id,...second},on(i));
      assert.deepEqual([preview.eligible,preview.alreadyRemindedToday,preview.reason],[false,true,'ALREADY_REMINDED_TODAY']);
      assert.equal((await reminders.listEligible(env,A,second,on(i))).members.find(x=>x.memberId===m.id).status,'ALREADY_REMINDED_TODAY');
    });
    await t.test('F/G: manual and bulk share the same daily slot in both directions',async()=>{
      const p=provider();await send(m,q,5,p);const bulk=await reminders.sendBulk(env,A,all,on(5,p));
      assert.equal(bulk.results.find(x=>x.memberId===m.id).reason,'ALREADY_REMINDED_TODAY');assert.equal(bulk.alreadyRemindedToday,1);
      const bulkFirst=await reminders.sendBulk(env,A,q,on(6,p));assert.equal(bulkFirst.results.find(x=>x.memberId===m.id).result,'DRY_RUN');
      const before=p.calls.length;assert.equal((await send(m,all,6,p)).reason,'ALREADY_REMINDED_TODAY');assert.equal(p.calls.length,before);
    });
    await t.test('J/K: FAILED releases slot; retry across scopes succeeds then blocks',async()=>{
      const bad=provider({success:false,errorCode:'TEST_FAILURE'});assert.equal((await send(m,q,7,bad)).result,'FAILED');
      assert.equal((await db.query('SELECT count(*)::int n FROM owner_fee_reminder_daily_claims WHERE member_id=$1 AND reminder_date=$2',[m.id,date(7)])).rows[0].n,0);
      assert.equal((await reminders.previewReminder(env,A,{memberId:m.id,...all},on(7))).alreadyRemindedToday,false);
      const good=provider();assert.equal((await send(m,all,7,good)).result,'DRY_RUN');assert.equal((await send(m,q,7,good)).reason,'ALREADY_REMINDED_TODAY');assert.equal(good.calls.length,1);
    });
    await t.test('L: stale SENDING recovered across scopes; recent SENDING stays locked; late completion cannot release replacement',async()=>{
      const seed=async(day,old)=> (await db.query(`INSERT INTO owner_fee_reminders(academy_id,member_id,scope_key,reminder_date,sender_number,recipient_number,message_body,total_outstanding,item_count,provider,created_at) VALUES($1,$2,'MONTH:legacy',$3,'+919876500001','+919100000001','test',1,1,'test',NOW()-make_interval(mins=>$4)) RETURNING id`,[academy.id,m.id,date(day),old])).rows[0];
      const abandoned=await seed(8,6);const before=await counts();
      assert.equal((await reminders.previewReminder(env,A,{memberId:m.id,...all},on(8))).eligible,true);assert.deepEqual(await counts(),before,'preview does not recover or write');
      assert.equal((await send(m,all,8,provider())).result,'DRY_RUN');
      const old=(await db.query('SELECT status,failure_code FROM owner_fee_reminders WHERE id=$1',[abandoned.id])).rows[0];assert.deepEqual(old,{status:'FAILED',failure_code:'ABANDONED'});
      await repo.complete(db,abandoned.id,{status:'FAILED',failureCode:'LATE'});assert.equal((await send(m,q,8,provider())).reason,'ALREADY_REMINDED_TODAY');
      await seed(9,0);const p=provider();assert.equal((await send(m,all,9,p)).reason,'ALREADY_REMINDED_TODAY');assert.equal(p.calls.length,0);
    });
    await t.test('M/N/O/P: next local date allowed; preview/list detect any scope and never claim',async()=>{
      const p=provider();assert.equal((await send(m,q,10,p)).result,'DRY_RUN');assert.equal((await send(m,all,11,p)).result,'DRY_RUN');
      const before=await counts();const pv=await reminders.previewReminder(env,A,{memberId:m.id,...q,type:'REGULAR'},on(11));assert.equal(pv.alreadyRemindedToday,true);
      const el=await reminders.listEligible(env,A,{...q,batchId:r2.id},on(11));assert.equal(el.summary.eligibleMembers,0);assert.equal(el.members[0].status,'ALREADY_REMINDED_TODAY');
      await reminders.previewReminder(env,A,{memberId:m.id,...q},on(12));assert.deepEqual(await counts(),before);
    });
    await t.test('Q: six simultaneous scopes/filters dispatch only once',async()=>{
      const p=provider();const scopes=[q,all,{...q,courtId:c1.id},{...q,courtId:c2.id},{...q,type:'REGULAR'},{...q,type:'COACHING'}];
      const results=await Promise.all(scopes.map(s=>send(m,s,13,p)));
      assert.deepEqual([results.filter(x=>x.result==='DRY_RUN').length,results.filter(x=>x.reason==='ALREADY_REMINDED_TODAY').length,p.calls.length],[1,5,1]);
      const live=(await db.query("SELECT count(*)::int n FROM owner_fee_reminders WHERE member_id=$1 AND reminder_date=$2 AND status IN ('SENDING','SENT','DRY_RUN')",[m.id,date(13)])).rows[0].n;assert.equal(live,1);
      assert.equal((await db.query('SELECT count(*)::int n FROM owner_fee_reminder_daily_claims WHERE member_id=$1 AND reminder_date=$2',[m.id,date(13)])).rows[0].n,1);
    });
    await t.test('database trigger also guards six direct concurrent inserts without service locks',async()=>{
      const clients=Array.from({length:6},()=>new pg.Client({connectionString:config.connectionString}));
      try{await Promise.all(clients.map(c=>c.connect()));
        const results=await Promise.all(clients.map((c,i)=>c.query(`INSERT INTO owner_fee_reminders(academy_id,member_id,scope_key,reminder_date,sender_number,recipient_number,message_body,total_outstanding,item_count,provider) VALUES($1,$2,$3,$4,'+91','+91','test',1,1,'test') RETURNING id`,[academy.id,m.id,`RACE:${i}`,date(14)])));
        assert.equal(results.reduce((n,r)=>n+r.rowCount,0),1);
      }finally{await Promise.all(clients.map(c=>c.end()));}
    });
    await t.test('R/S: Owner A does not block Owner B; Member A does not block Member B',async()=>{
      assert.equal((await send(m,q,15,provider())).result,'DRY_RUN');assert.equal((await send(n,all,15,provider())).result,'DRY_RUN');
      const result=await reminders.sendReminder(env,B,{memberId:bm.id,academyId:otherAcademy.id,scope:'MONTH',feeMonth:month},on(15,provider()));assert.equal(result.result,'DRY_RUN');
      await assert.rejects(reminders.sendReminder(env,B,{memberId:m.id,...q},on(15,provider())),e=>e.status===404);
    });
    await t.test('T/U: original Phase-8 duplicate rows and scopes remain byte-for-byte intact',async()=>{
      const evidence=JSON.parse(await readFile(new URL('../docs/validation/phase-8.1-migration.json',import.meta.url),'utf8'));
      for(const r of evidence.historyBefore) assert.deepEqual((await db.query('SELECT row_to_json(r) row FROM owner_fee_reminders r WHERE id=$1',[r.row.id])).rows[0],r);
      assert.equal(evidence.historyPreserved,true);assert.equal(evidence.historyBefore.length,2);
      const original=evidence.historyBefore[0].row;
      const identity=(await db.query('SELECT p.user_id FROM owner_academies a JOIN owner_profiles p ON p.id=a.owner_profile_id WHERE a.id=$1',[original.academy_id])).rows[0];
      const history=await reminders.listReminders(env,{sub:identity.user_id,role:'PLAYER'},{academyId:original.academy_id,memberId:original.member_id});
      assert.deepEqual(history.items.map(x=>x.scope).sort(),['ALL_OUTSTANDING',`MONTH:2026-10-01`]);
    });
    await t.test('V/W/X: payment/leave recheck, missing mobile, exact money unchanged',async()=>{
      const before=await counts();
      for(const member of [paid,leave]) assert.equal((await reminders.previewReminder(env,A,{memberId:member.id,...q},on(16))).eligible,true);
      const fee=(await api(a,'GET',`/monthly-fees?academyId=${academy.id}&feeMonth=${month}`)).items.find(x=>x.memberId===paid.id);
      await api(a,'POST','/payments',{memberId:paid.id,amount:'1000.10',paymentMode:'CASH',paymentDate:todayIST(),allocationMode:'MANUAL',allocations:[{monthlyFeeId:fee.id,amount:'1000.10'}]});
      await api(a,'POST',`/memberships/${leaveMs.id}/leaves`,{feeMonth:month});const p=provider();
      for(const [member,reason] of [[paid,'PAID'],[leave,'ON_LEAVE'],[missing,'MISSING_MOBILE']])assert.equal((await send(member,q,16,p)).reason,reason);
      assert.equal(p.calls.length,0);assert.deepEqual(await counts(),before);
      const result=await send(m,q,16,p);assert.equal(result.reminder.totalOutstanding,'3000.30');assert.match(result.reminder.message,/₹3,000\.30/);
    });
    for(const original of existing) assert.deepEqual((await db.query('SELECT row_to_json(r) row FROM owner_fee_reminders r WHERE id=$1',[original.row.id])).rows[0],original);
  } finally {
    const ids=users.map(x=>x.id);
    const academies='(SELECT a.id FROM owner_academies a JOIN owner_profiles p ON p.id=a.owner_profile_id WHERE p.user_id=ANY($1))';
    await db.query('BEGIN');await db.query("SET LOCAL smashpoint.owner_reminder_cleanup='on'");await db.query("SET LOCAL smashpoint.owner_payment_cleanup='on'");
    try{
      for(const table of ['owner_fee_reminders','owner_payments','owner_receipt_counters','owner_members','owner_batches','owner_courts']) {
        if(table==='owner_members') {
          for(const child of ['owner_payment_allocations','owner_monthly_fees','owner_monthly_leaves','owner_memberships']) {
            const condition=child==='owner_payment_allocations' ? `monthly_fee_id IN (SELECT f.id FROM owner_monthly_fees f JOIN owner_memberships ms ON ms.id=f.membership_id JOIN owner_members m ON m.id=ms.member_id WHERE m.academy_id IN ${academies})` : child==='owner_memberships' ? `member_id IN (SELECT id FROM owner_members WHERE academy_id IN ${academies})` : `membership_id IN (SELECT ms.id FROM owner_memberships ms JOIN owner_members m ON m.id=ms.member_id WHERE m.academy_id IN ${academies})`;
            await db.query(`DELETE FROM ${child} WHERE ${condition}`,[ids]);
          }
        }
        if(table==='owner_batches')await db.query(`DELETE FROM owner_fee_rates WHERE batch_id IN (SELECT id FROM owner_batches WHERE academy_id IN ${academies})`,[ids]);
        // Payments are removed only after their allocations below; see preceding cleanup.
        if(table==='owner_payments')await db.query(`DELETE FROM owner_payment_allocations WHERE payment_id IN (SELECT id FROM owner_payments WHERE academy_id IN ${academies})`,[ids]);
        await db.query(`DELETE FROM ${table} WHERE academy_id IN ${academies}`,[ids]);
      }
      await db.query(`DELETE FROM owner_academies WHERE id IN ${academies}`,[ids]);await db.query('DELETE FROM owner_profiles WHERE user_id=ANY($1)',[ids]);await db.query('DELETE FROM users WHERE id=ANY($1)',[ids]);await db.query('COMMIT');
    }catch(e){await db.query('ROLLBACK');throw e;}finally{await db.end();}
  }
});
