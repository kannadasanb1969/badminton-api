import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from 'pg';
import {handleTournamentRoutes} from '../src/routes/tournament.routes.js';
import {mapTournament} from '../src/mappers/tournament.mapper.js';
const original={connect:Client.prototype.connect,end:Client.prototype.end,query:Client.prototype.query};
let calls=[],rows=[];
Client.prototype.connect=async()=>{};Client.prototype.end=async()=>{};
Client.prototype.query=async(sql,params)=>{calls.push({sql,params});if(/^(BEGIN|COMMIT|ROLLBACK)/.test(sql))return {rows:[]};assert.ok(rows.length,'Unexpected query');return {rows:rows.shift()};};
after(()=>Object.assign(Client.prototype,original));
const env={HYPERDRIVE:{connectionString:'postgres://localhost/test'}};
const request=(method,path,input)=>handleTournamentRoutes(new Request('http://localhost/api/tournaments'+path,{method,...(input?{body:JSON.stringify(input)}:{})}),env);
test('mapper nests camelCase categories and ordered string rules with date-only values',()=>{
const mapped=mapTournament({id:'t',tournament_code:'TRN000001',tournament_date:new Date('2026-10-10Z')},[{event_type:'MIXED_DOUBLES',gender_eligibility:'MIXED'}],[{rule_text:'First'},{rule_text:'Second'}]);
assert.equal(mapped.startDate,'2026-10-10');assert.equal(mapped.categories[0].gender,'MIXED');
assert.equal(mapped.endDate,null);assert.equal(mapped.registrationStartDate,null);assert.equal(mapped.entryFee,null);assert.ok(!('tournamentDate' in mapped));assert.equal(mapped.categories[0].eventType,'MIXED_DOUBLES');assert.deepEqual(mapped.generalRules,['First','Second']);assert.ok(Object.keys(mapped).every(k=>!k.includes('_')));
});
test('invalid date ranges fail before SQL',async()=>{
calls=[];
for(const input of [{name:'Test',startDate:'2026-10-10',registrationEndDate:'2026-10-11'},{name:'Test',startDate:'2026-02-30'}])assert.equal((await request('POST','',input)).status,400);
assert.equal(calls.length,0);
});
test('organizer approval and draft publication are blocked with rollback',async()=>{
for(const [action,role,status] of [['approve','ORGANIZER',403],['publish','ADMIN',409]]){
calls=[];rows=[[{id:'t',organizer_id:'owner',status:'DRAFT'}],[{id:'actor',role,is_active:true}]];
assert.equal((await request('POST','/t/'+action,{adminUserId:'actor'})).status,status);assert.equal(calls.at(-1).sql,'ROLLBACK');assert.ok(!calls.some(c=>c.sql.startsWith('UPDATE')));
}
});
test('DELETE remains unsupported without touching SQL',async()=>{calls=[];assert.equal((await request('DELETE','/t')).status,405);assert.equal(calls.length,0);});
