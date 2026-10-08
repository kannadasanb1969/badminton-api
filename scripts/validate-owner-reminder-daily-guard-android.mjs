// Prepare a separate q2 Owner academy for Android validation; no existing academy is edited.
import { localEnvironment, safeClient } from './validate-owner-reminder-daily-guard.mjs';
import { issueAccessToken } from '../src/utils/auth-token.js';
import { currentMonthIST } from '../src/utils/owner-dates.js';
import { writeFile, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const env = await localEnvironment();
const base = 'http://localhost:8787';
const sessionFile = '/tmp/phase81-android-session.json';
const evidenceFile = new URL('../docs/validation/phase-8.1-android-api.json', import.meta.url);
const existingAcademyId = '4afd31ad-5031-474b-896a-a9fae2d9d9ce';
const action = process.argv[2];
const db = await safeClient(env);
try {
  if (action === 'prepare') {
    const mobile = '+919108100081';
    assert.equal((await db.query('SELECT count(*)::int n FROM users WHERE mobile=$1',[mobile])).rows[0].n,0,'fixture already exists; inspect rather than recreate');
    const originalProfile = (await db.query('SELECT p.user_id FROM owner_academies a JOIN owner_profiles p ON p.id=a.owner_profile_id WHERE a.id=$1',[existingAcademyId])).rows[0];
    const originalToken = await issueAccessToken(env,{id:originalProfile.user_id,role:'PLAYER'});
    const user = (await db.query("INSERT INTO users(mobile,role) VALUES($1,'PLAYER') RETURNING id,role",[mobile])).rows[0];
    const token = await issueAccessToken(env,user);
    const api = async(method,path,body,t=token)=>{
      const r=await fetch(`${base}/api/owner${path}`,{method,headers:{authorization:`Bearer ${t}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
      const result=await r.json();assert.ok(r.ok,`${method} ${path}: ${JSON.stringify(result)}`);return result.data;
    };
    const month=currentMonthIST();
    const originalDashboard=await api('GET',`/dashboard?academyId=${existingAcademyId}&feeMonth=${month}`,null,originalToken);
    const originalFees=await api('GET',`/monthly-fees?academyId=${existingAcademyId}&feeMonth=${month}`,null,originalToken);
    await api('POST','/profile');
    const academy=await api('POST','/academies',{name:'Phase 8.1 Daily Guard Test'});
    const courts=[];const batches=[];
    for(const [name,type,fee] of [['Court 1','REGULAR','1000.10'],['Court 2','COACHING','2000.20']]){
      const c=await api('POST',`/academies/${academy.id}/courts`,{name});courts.push(c);
      const b=await api('POST','/batches',{academyId:academy.id,courtId:c.id,name:type==='REGULAR'?'Batch A':'Batch B',type,startTime:'06:00',endTime:'07:00',feePerPerson:fee});batches.push(b);
    }
    const member=await api('POST','/members',{academyId:academy.id,name:'Phase81 Kumar',mobile:'9108100082'});
    for(const batch of batches)await api('POST',`/members/${member.id}/memberships`,{batchId:batch.id,startDate:month});
    await api('POST','/monthly-fees/generate',{academyId:academy.id,feeMonth:month});
    const dashboard=await api('GET',`/dashboard?academyId=${academy.id}&feeMonth=${month}`);
    const fees=await api('GET',`/monthly-fees?academyId=${academy.id}&feeMonth=${month}`);
    const evidence={userId:user.id,mobile,academyId:academy.id,memberId:member.id,month,courts,batches,dashboardBefore:dashboard.financial,feesBefore:fees.summary,originalDashboardBefore:originalDashboard.financial,originalFeesBefore:originalFees.summary};
    await writeFile(evidenceFile,JSON.stringify(evidence,null,2)+'\n');await writeFile(sessionFile,JSON.stringify({token,originalToken,...evidence}),{mode:0o600});
    console.log(JSON.stringify({mobile,academy:academy.name,member:member.name,fees:fees.summary}));
  } else if(action==='add-control'){
    const s=JSON.parse(await readFile(sessionFile,'utf8'));const evidence=JSON.parse(await readFile(evidenceFile,'utf8'));
    assert.ok(!evidence.bulkMemberId,'control already prepared');
    const api=async(method,path,body)=>{const r=await fetch(`${base}/api/owner${path}`,{method,headers:{authorization:`Bearer ${s.token}`,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const result=await r.json();assert.ok(r.ok,JSON.stringify(result));return result.data;};
    const member=await api('POST','/members',{academyId:s.academyId,name:'Phase81 Bulk Control',mobile:'9108100083'});
    await api('POST',`/members/${member.id}/memberships`,{batchId:s.batches[0].id,startDate:s.month});
    await api('POST','/monthly-fees/generate',{academyId:s.academyId,feeMonth:s.month});
    evidence.bulkMemberId=member.id;evidence.dashboardBefore=(await api('GET',`/dashboard?academyId=${s.academyId}&feeMonth=${s.month}`)).financial;
    evidence.feesBefore=(await api('GET',`/monthly-fees?academyId=${s.academyId}&feeMonth=${s.month}`)).summary;
    await writeFile(evidenceFile,JSON.stringify(evidence,null,2)+'\n');await writeFile(sessionFile,JSON.stringify({...s,...evidence}),{mode:0o600});console.log(JSON.stringify({bulkMember:member.name,fees:evidence.feesBefore}));
  } else if(action==='verify'){
    const s=JSON.parse(await readFile(sessionFile,'utf8'));const evidence=JSON.parse(await readFile(evidenceFile,'utf8'));
    const api=async(path,t=s.token)=>{const r=await fetch(`${base}/api/owner${path}`,{headers:{authorization:`Bearer ${t}`}});assert.ok(r.ok,`${path}: ${r.status}`);return (await r.json()).data;};
    const dashboard=await api(`/dashboard?academyId=${s.academyId}&feeMonth=${s.month}`);const fees=await api(`/monthly-fees?academyId=${s.academyId}&feeMonth=${s.month}`);
    assert.deepEqual(dashboard.financial,s.dashboardBefore);assert.deepEqual(fees.summary,s.feesBefore);
    assert.deepEqual((await api(`/dashboard?academyId=${existingAcademyId}&feeMonth=${s.month}`,s.originalToken)).financial,s.originalDashboardBefore);
    assert.deepEqual((await api(`/monthly-fees?academyId=${existingAcademyId}&feeMonth=${s.month}`,s.originalToken)).summary,s.originalFeesBefore);
    const history=await api(`/reminders?academyId=${s.academyId}`);assert.equal(history.items.length,2);assert.ok(history.items.every(x=>x.status==='DRY_RUN'));assert.equal(history.items.find(x=>x.memberId===s.memberId).scope,`MONTH:${s.month}`);assert.equal(history.items.find(x=>x.memberId===s.bulkMemberId).scope,'ALL_OUTSTANDING');
    for(const scope of ['MONTH','ALL_OUTSTANDING']) {
      const list=await api(`/reminders/eligible?academyId=${s.academyId}&scope=${scope}&feeMonth=${s.month}`);assert.ok(list.members.every(x=>x.status==='ALREADY_REMINDED_TODAY'));assert.equal(list.summary.eligibleMembers,0);
    }
    evidence.history=history.items;evidence.dashboardAfter=dashboard.financial;evidence.feesAfter=fees.summary;evidence.financialTotalsUnchanged=true;evidence.originalAcademyUnchanged=true;
    await writeFile(evidenceFile,JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({historyRows:history.items.length,financialTotalsUnchanged:true,originalAcademyUnchanged:true,status:history.items[0].status,scope:history.items[0].scope}));
  }else throw Error('Use prepare or verify');
}finally{await db.end();}
