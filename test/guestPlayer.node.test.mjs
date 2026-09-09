import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { mapGuestPlayerRow } from '../src/mappers/guestPlayer.mapper.js';
import { handleGuestPlayerRoutes } from '../src/routes/guestPlayer.routes.js';

const original = { connect: Client.prototype.connect, end: Client.prototype.end, query: Client.prototype.query };
let results, calls;
Client.prototype.connect = async function () {};
Client.prototype.end = async function () {};
Client.prototype.query = async function (sql, params) {
  calls.push({ sql, params });
  if (/^(BEGIN|COMMIT|ROLLBACK|LOCK TABLE)/.test(sql)) return { rows: [] };
  assert.ok(results.length, 'Unexpected database query');
  return { rows: results.shift() };
};
beforeEach(() => { results = []; calls = []; });
after(() => Object.assign(Client.prototype, original));
const env = { HYPERDRIVE: { connectionString: 'postgres://localhost/test' } };
const request = (method, path = '', data) => handleGuestPlayerRoutes(new Request(`http://localhost/api/guest-players${path}`, {
  method, ...(data === undefined ? {} : { body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' } }),
}), env);

test('guest mapper handles birthdays, leap dates, nulls and camelCase', () => {
  const row={dob:'1996-08-20',playing_since:2020};
  assert.equal(mapGuestPlayerRow(row,new Date('2026-08-19Z')).age,29);
  const mapped=mapGuestPlayerRow(row,new Date('2026-08-20Z'));
  assert.equal(mapped.age,30); assert.equal(mapped.experienceYears,6);
  assert.equal(mapped.dob,'1996-08-20');
  assert.ok(Object.keys(mapped).every(k=>!k.includes('_')));
  assert.equal(mapGuestPlayerRow({dob:new Date('2000-02-29Z')},new Date('2025-02-28Z')).age,24);
  assert.equal(mapGuestPlayerRow({dob:'2000-02-29'},new Date('2025-03-01Z')).age,25);
  assert.equal(mapGuestPlayerRow({}).age,null);
  assert.equal(mapGuestPlayerRow({}).experienceYears,null);
});
test('required fields, malformed dates and DELETE are rejected without SQL',async()=>{
  for(const body of [{mobile:'1'},{fullName:'A'},{fullName:' ',mobile:'1'},{fullName:'A',mobile:'1',dob:'2026-02-30'}]) {
    assert.equal((await request('POST','',body)).status,400);
  }
  assert.equal((await request('DELETE','/id')).status,405);
  assert.equal(calls.length,0);
});
const existing={id:'id',guest_code:'GST000001',full_name:'Guest',mobile:'123',gender:null,dob:null,location:null,playing_since:null,regular_player:false,court_academy:null,linked_player_id:'player-id',claimed_at:'2026-01-01',created_at:'2025-01-01'};
test('partial updates cannot overwrite IDs or claim fields',async()=>{
  results=[[existing],[{...existing,location:'Tambaram'}]];
  const r=await request('PUT','/id',{location:'Tambaram',id:'evil',guestCode:'evil',linkedPlayerId:'evil',claimedAt:'evil',createdAt:'evil'});
  assert.equal(r.status,200);const b=await r.json();assert.equal(b.data.linkedPlayerId,'player-id');assert.equal(b.data.guestCode,'GST000001');
  const update=calls.find(c=>c.sql.includes('UPDATE guest_players'));
  assert.ok(!update.params.includes('evil'));assert.equal(update.params[4],'Tambaram');
});
test('identity updates check guest and registered-player duplicates',async()=>{
  results=[[existing],[],[{id:'registered'}]];
  const r=await request('PUT','/id',{fullName:'Registered'});
  assert.equal(r.status,409);assert.equal((await r.json()).message,'This person already has a registered player profile');
  assert.ok(!calls.some(c=>c.sql.includes('UPDATE guest_players')));
  results=[[existing],[{id:'other'}]];
  assert.equal((await request('PUT','/id',{mobile:'456'})).status,409);
});
test('create generates padded code and keeps identity input parameterized',async()=>{
  results=[[],[],[{number:'9'}],[{...existing,guest_code:'GST000010'}]];
  const r=await request('POST','',{fullName:"  O'Brien  ",mobile:' 123 '});
  assert.equal(r.status,201);assert.equal((await r.json()).data.guestCode,'GST000010');
  const insert=calls.find(c=>c.sql.includes('INSERT INTO'));
  assert.equal(insert.params[0],"O'Brien");assert.equal(insert.params[1],'123');assert.equal(insert.params[8],'GST000010');assert.ok(!insert.sql.includes("O'Brien"));
});
