import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from 'pg';
import {listTournaments} from '../src/services/tournament.service.js';
const original={connect:Client.prototype.connect,end:Client.prototype.end,query:Client.prototype.query};
Client.prototype.connect=async()=>{};Client.prototype.end=async()=>{};
after(()=>Object.assign(Client.prototype,original));
test('tournament list completion summaries use seven bulk queries for one or fifty tournaments',async()=>{
 for(const count of [1,50]){
  let calls=0;
  const tournaments=Array.from({length:count},(_,i)=>({id:`t${i}`,name:`Tournament ${i}`,status:'PUBLISHED'}));
  const categories=tournaments.map(t=>({id:`c${t.id}`,tournament_id:t.id,name:'Singles',event_type:'SINGLES'}));
  Client.prototype.query=async(sql)=>{
   calls++;
   if(sql.startsWith('SELECT t.*'))return {rows:tournaments};
   if(sql.startsWith('SELECT * FROM tournament_categories'))return {rows:categories};
   if(sql.startsWith('SELECT m.*'))return {rows:categories.map(c=>({id:`m${c.id}`,tournament_id:c.tournament_id,category_id:c.id,winner_id:'winner',participant1_id:'winner',participant2_id:'runner'}))};
   if(sql.startsWith('WITH participants AS'))return {rows:categories.map(c=>({id:`r${c.id}`,tournament_id:c.tournament_id,category_id:c.id,event_type:'SINGLES',winner_participant_id:'winner',runner_up_participant_id:'runner',winner_name:'Winner',runner_up_name:'Runner',completed_at:'2026-09-12'}))};
   return {rows:[]};
  };
  const list=await listTournaments({HYPERDRIVE:{connectionString:'postgres://localhost/test'}});
  assert.equal(calls,7);assert.equal(list.length,count);
  assert.ok(list.every(t=>t.completionStatus==='COMPLETED' && t.categories[0].completionStatus==='COMPLETED'));
  assert.equal(list[0].result.winnerParticipantName,'Winner');
 }
});
