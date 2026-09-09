import {test} from 'node:test';import assert from 'node:assert/strict';
import {checkEligibility} from '../src/services/eligibility.service.js';
import {mapRegistrationRow} from '../src/mappers/registration.mapper.js';
function setup(overrides={}) {
 const t={id:'t',status:'PUBLISHED',today:'2026-09-09',registration_close_date:'2026-10-05'};
 const c={id:'c',tournament_id:'t',event_type:'SINGLES',gender_eligibility:'MALE',registration_phase:'OPEN',medalists_allowed:true};
 const p={id:'p',profile_status:'ACTIVE',gender:'MALE',dob:'1995-05-10'};
 const state={t,c,p,partner:{...p,id:'partner'},...overrides};
 const db={query:async(sql,params)=>{
  if(sql.includes('FROM tournaments'))return {rows:state.t?[state.t]:[]};
  if(sql.includes('FROM tournament_categories'))return {rows:[state.c]};
  if(sql.includes('FROM player_profiles'))return {rows:[params[0]==='p'?state.p:state.partner]};
  if(sql.includes('FROM guest_players')&&!sql.includes('medal_history'))return {rows:[state.partner]};
  if(sql.includes('FROM medal_history'))return {rows:state.medalist?[{id:'medal'}]:[]};
  if(sql.includes('count(*)'))return {rows:[{count:state.count??0}]};
  if(sql.includes('SELECT id,status,player_id'))return {rows:state.duplicate===params[2]?[{id:'r'}]:[]};
  if(sql.includes('SELECT id,status'))return {rows:state.history?[state.history]:[]};
  throw new Error('Unexpected SQL');
 }};return {state,db,input:{tournamentId:'t',categoryId:'c',playerId:'p'}};
}
test('age boundary, inactive, gender and closed window produce decisions',async()=>{
 for(const [change,code] of [
  [s=>s.p.profile_status='INACTIVE','PLAYER_INACTIVE'],
  [s=>s.c.gender_eligibility='FEMALE','GENDER_NOT_ELIGIBLE'],
  [s=>s.c.max_age=30,'AGE_NOT_ELIGIBLE'],
  [s=>s.t.registration_close_date='2026-09-08','REGISTRATION_CLOSED'],
  [s=>s.c.tournament_id='other','CATEGORY_NOT_IN_TOURNAMENT'],
  [s=>s.t.status='DRAFT','TOURNAMENT_NOT_PUBLISHED']]) {
   const {state,db,input}=setup();change(state);assert.ok((await checkEligibility(db,input)).reasons.some(r=>r.code===code));
 }
 const {state,db,input}=setup();state.c.min_age=31;state.c.max_age=31;assert.equal((await checkEligibility(db,input)).eligible,true);
});
test('registered and guest medal histories block both participants',async()=>{
 for(const type of ['PLAYER','GUEST']){const {state,db,input}=setup({medalist:true});state.c.event_type='DOUBLES';state.c.medalists_allowed=false;input.partner={type,id:'partner'};const r=await checkEligibility(db,input);assert.equal(r.reasons.filter(x=>x.code==='MEDALIST_NOT_ALLOWED').length,2);}
});
test('duplicate partners, claimed guests, capacity and cancelled history are blocked',async()=>{
 for(const [change,code]of [
  [s=>s.duplicate='partner','PARTNER_ALREADY_REGISTERED'],
  [s=>s.partner.linked_player_id='p','GUEST_ALREADY_CLAIMED'],
  [s=>{s.c.max_teams=1;s.count=1;},'CATEGORY_FULL'],
  [s=>s.history={status:'CANCELLED'},'REGISTRATION_HISTORY_EXISTS']]){
   const {state,db,input}=setup();state.c.event_type='DOUBLES';input.partner={type:'GUEST',id:'partner'};change(state);assert.ok((await checkEligibility(db,input)).reasons.some(r=>r.code===code));
 }
});
test('missing resources are 404 and singles partner input is 400',async()=>{
 const {state,db,input}=setup();state.t=null;await assert.rejects(checkEligibility(db,input),{status:404,code:'TOURNAMENT_NOT_FOUND'});
 const other=setup();await assert.rejects(checkEligibility(other.db,{...other.input,partner:{id:'partner',type:'PLAYER'}}),{status:400});
});
test('registration mapper translates partner FULL to PLAYER and retains dates/history',()=>{
 const r=mapRegistrationRow({id:'r',registration_code:'REG000001',partner_type:'FULL',partner_id:'p',cancelled_at:'date',status:'CANCELLED'});
 assert.equal(r.partner.type,'PLAYER');assert.equal(r.partnerType,'PLAYER');assert.equal(r.cancelledAt,'date');assert.ok(Object.keys(r).every(k=>!k.includes('_')));
});
