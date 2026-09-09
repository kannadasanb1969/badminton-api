import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { mapPlayerRow } from '../src/mappers/player.mapper.js';
import { handlePlayerRoutes } from '../src/routes/player.routes.js';

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
const request = (method, path = '', data) => handlePlayerRoutes(new Request(`http://localhost/api/players${path}`, {
  method, ...(data === undefined ? {} : { body: JSON.stringify(data), headers: { 'Content-Type': 'application/json' } }),
}), env);

test('rejects empty required fields and invalid types before connecting', async () => {
  for (const data of [{ mobile: '1' }, { fullName: '  ', mobile: '1' }, { fullName: 'A', mobile: 1 },
    { fullName: 'A', mobile: '1', regularPlayer: 'false' }, { fullName: 'A', mobile: '1', dob: '2025-02-30' }]) {
    assert.equal((await request('POST', '', data)).status, 400);
  }
  assert.equal(calls.length, 0);
});

test('creates padded code, trims identity and passes SQL-like input as a parameter', async () => {
  results = [[], [{ number: '9' }], [{ id: 'uuid', player_code: 'PLR000010' }]];
  const response = await request('POST', '', { fullName: "  O'Brien'; DROP TABLE x;--  ", mobile: ' 123 ' });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).data.playerCode, 'PLR000010');
  const insert = calls.find(c => c.sql.includes('INSERT INTO'));
  assert.equal(insert.params[0], "O'Brien'; DROP TABLE x;--");
  assert.equal(insert.params[1], '123');
  assert.equal(insert.params[6], false);
  assert.equal(insert.params[9], 'ACTIVE');
  assert.equal(insert.params[10], 'PLR000010');
  assert.ok(!insert.sql.includes("O'Brien"));
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('duplicate creates return exact 409 and roll back', async () => {
  results = [[{ id: 'existing' }]];
  const response = await request('POST', '', { fullName: ' Player ', mobile: ' 123 ' });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { success: false, message: 'A player with this name and mobile number already exists' });
  assert.equal(calls.at(-1).sql, 'ROLLBACK');
  assert.match(calls[2].sql, /lower\(btrim\(full_name\)\)/);
});

const existing = { id: 'uuid', full_name: 'Player', mobile: '123', gender: null, dob: null, location: 'Old',
  playing_since: 2018, regular_player: true, court_academy: null, profile_photo_url: null, profile_status: 'ACTIVE' };

test('partial updates preserve fields and exclude the current ID from duplicate check', async () => {
  results = [[existing], [], [{ ...existing, location: 'Chennai' }]];
  const response = await request('PUT', '/uuid', { location: 'Chennai', profilePhoto: 'https://example.com/photo.jpg' });
  assert.equal(response.status, 200);
  const duplicate = calls.find(c => c.sql.includes('SELECT id'));
  assert.deepEqual(duplicate.params, ['Player', '123', 'uuid']);
  const update = calls.find(c => c.sql.includes('UPDATE player_profiles'));
  assert.equal(update.params[0], 'Player');
  assert.equal(update.params[4], 'Chennai');
  assert.equal(update.params[8], 'https://example.com/photo.jpg');
  assert.equal(update.params[6], true);
});

test('update conflicts return 409', async () => {
  results = [[existing], [{ id: 'other' }]];
  assert.equal((await request('PUT', '/uuid', { mobile: '456' })).status, 409);
  assert.ok(!calls.some(c => c.sql.includes('UPDATE player_profiles')));
});

test('missing records return 404 for all single-record operations', async () => {
  for (const [method, path, data] of [['GET', '/missing'], ['GET', '/code/PLR000001'], ['PUT', '/missing', {}], ['DELETE', '/missing']]) {
    results = [[]];
    assert.equal((await request(method, path, data)).status, 404);
  }
});

test('list, code lookup and delete return records', async () => {
  results = [[existing], [existing], [existing]];
  assert.deepEqual((await (await request('GET')).json()).data, [JSON.parse(JSON.stringify(mapPlayerRow(existing)))]);
  assert.match(calls[0].sql, /ORDER BY created_at DESC/);
  assert.equal((await request('GET', '/code/PLR000001')).status, 200);
  assert.equal((await request('DELETE', '/uuid')).status, 200);
});

test('malformed JSON and unsupported routes/methods get HTTP errors', async () => {
  assert.equal((await handlePlayerRoutes(new Request('http://localhost/api/players', { method: 'POST', body: '{' }), env)).status, 400);
  assert.equal((await request('PATCH')).status, 405);
  assert.equal((await request('GET', '/unknown/extra')).status, 404);
});

test('mapper uses camelCase, date-only DOB and birthday-aware age', () => {
  const row = { ...existing, dob: new Date('1995-05-10T00:00:00Z'), player_code: 'PLR000001' };
  const before = mapPlayerRow(row, new Date('2026-05-09T23:59:59Z'));
  assert.equal(before.age, 30);
  assert.equal(before.experienceYears, 8);
  assert.equal(before.dob, '1995-05-10');
  assert.equal(before.profilePhoto, null);
  assert.ok(Object.keys(before).every(key => !key.includes('_')));
  assert.equal(mapPlayerRow(row, new Date('2026-05-10T00:00:00Z')).age, 31);
  assert.equal(mapPlayerRow({ ...row, dob: '2000-02-29' }, new Date('2025-02-28T00:00:00Z')).age, 24);
  assert.equal(mapPlayerRow({ ...row, dob: '2000-02-29' }, new Date('2025-03-01T00:00:00Z')).age, 25);
  const unknown = mapPlayerRow({ ...row, dob: null, playing_since: null });
  assert.equal(unknown.age, null);
  assert.equal(unknown.experienceYears, null);
});
