import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { handleMatchRoutes } from '../src/routes/match.routes.js';
import { issueAccessToken } from '../src/utils/auth-token.js';
import { insertMatch } from '../src/repositories/fixture.repository.js';
const original = { connect: Client.prototype.connect, end: Client.prototype.end, query: Client.prototype.query };
const env = { HYPERDRIVE: { connectionString: 'postgres://localhost/test' }, AUTH_TOKEN_SECRET: 'test-only-secret' };
let match, history, calls, results, medals, final;
beforeEach(() => {
  match = { id: 'm', fixture_id: 'f', tournament_id: 't', category_id: 'c', status: 'SCHEDULED', participant1_id: 'p1', participant2_id: 'p2', participant1_type: 'PLAYER', participant2_type: 'PLAYER', participant1_score: 0, participant2_score: 0, winning_points: null, round_number: 1 };
  history = []; calls = []; results = []; medals = []; final = false;
});
Client.prototype.connect = async () => {};
Client.prototype.end = async () => {};
Client.prototype.query = async (sql, params = []) => {
  calls.push({ sql, params });
  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
  if (sql.startsWith('SELECT * FROM users')) return { rows: [{ id: params[0], role: params[0] === 'player' ? 'PLAYER' : 'ORGANIZER', is_active: true }] };
  if (sql.startsWith('SELECT organizer_id')) return { rows: [{ organizer_id: 'owner' }] };
  if (sql.startsWith('SELECT f.status')) return { rows: [{ status: 'PUBLISHED', format: 'KNOCKOUT' }] };
  if (sql.startsWith('SELECT id,round_number')) return { rows: final ? [match] : [match, { id: 'another', round_number: 1 }] };
  if (sql.startsWith('SELECT m.* FROM matches m JOIN fixtures')) return { rows: final && match.status === 'COMPLETED' ? [{ ...match }] : [] };
  if (sql.startsWith('SELECT m.* FROM matches m WHERE m.id=$1 FOR UPDATE')) return { rows: [{ ...match, participant1_id: null, participant2_id: null, participant1_type: null, participant2_type: null }] };
  if (sql.startsWith('SELECT * FROM matches')) return { rows: [ { ...match } ] };
  if (sql.startsWith('UPDATE matches SET status=')) { match = { ...match, status: 'LIVE', winning_points: params[1] }; return { rows: [match] }; }
  if (sql.startsWith('UPDATE matches SET participant1_score')) { match = { ...match, participant1_score: params[1], participant2_score: params[2], status: params[3], winner_id: params[4] }; return { rows: [match] }; }
  if (sql.startsWith('INSERT INTO match_score_history')) { history.push(params); return { rows: [{}] }; }
  if (sql.startsWith('SELECT * FROM match_score_history')) return { rows: history.map((x, id) => ({ id, participant1_score: x[1], participant2_score: x[2] })) };
  if (sql.startsWith('SELECT full_name')) return { rows: [{ name: 'Winner', code: 'PLY1' }] };
  if (sql.startsWith('SELECT * FROM results')) return { rows: results };
  if (sql.startsWith('SELECT next_match_id,next_match_slot')) return { rows: [{ next_match_id: null, next_match_slot: null }] };
  if (sql.startsWith('INSERT INTO results')) { results.push({ id: params[0], event_type: params[3], winner_participant_id: params[4] }); return { rows: results }; }
  if (sql.startsWith('INSERT INTO medal_history')) { medals.push(params); return { rows: [{}] }; }
  if (sql.startsWith('SELECT user_id')) return { rows: [] };
  throw new Error(`Unexpected SQL: ${sql}`);
};
after(() => Object.assign(Client.prototype, original));
async function request(action, input = {}, actor = 'owner', method = 'POST') {
  const headers = { 'Content-Type': 'application/json' };
  if (actor) headers.Authorization = `Bearer ${await issueAccessToken(env, { id: actor, role: actor === 'player' ? 'PLAYER' : 'ORGANIZER' })}`;
  const response = await handleMatchRoutes(new Request(`http://localhost/api/matches/m${action ? '/' + action : ''}`, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(input) } : {}) }), env);
  return { status: response.status, body: await response.json() };
}
for (const limit of [15, 21, 30]) {
  test(`${limit}: requires selection, persists ceiling, remains LIVE, decrements, manually completes`, async () => {
    assert.equal((await request('start')).status, 400);
    assert.equal((await request('start', { winningPoints: limit })).body.data.winningPoints, limit);
    match.participant1_score = limit - 1; match.participant2_score = limit - 3;
    let response = await request('score', { side: 'A', action: 'INCREMENT' });
    assert.equal(response.body.data.status, 'LIVE'); assert.equal(response.body.data.participant1Score, limit); assert.equal(match.winner_id, null);
    assert.equal((await request('score', { side: 'A' })).status, 409);
    assert.equal(match.participant1_score, limit);
    assert.equal((await request('score', { side: 'A', action: 'DECREMENT' })).body.data.participant1Score, limit - 1);
    assert.equal((await request('score', { side: 'A' })).body.data.status, 'LIVE');
    assert.equal(history.length, 3);
    const playerView = await request('', {}, 'player', 'GET');
    assert.equal(playerView.body.data.status, 'LIVE'); assert.equal(playerView.body.data.winningPoints, limit);
    response = await request('complete');
    assert.equal(response.body.data.status, 'COMPLETED'); assert.equal(response.body.data.winnerId, 'p1');
    assert.equal((await request('', {}, 'player', 'GET')).body.data.status, 'COMPLETED');
    assert.equal((await request('score', { side: 'B' })).status, 409);
  });
}
test('ties, scheduled completion, invalid points/actions, negative scores and authorization rejected', async () => {
  assert.equal((await request('complete')).status, 400);
  for (const winningPoints of [0, 16, 22, 31, '21']) assert.equal((await request('start', { winningPoints })).status, 400);
  await request('start', { winningPoints: 15 });
  for (const actor of [null, 'player', 'other']) assert.ok((await request('score', { side: 'A' }, actor)).status >= 400);
  assert.equal((await request('score', { side: 'C' })).status, 400);
  assert.equal((await request('score', { side: 'A', action: 'SET' })).status, 400);
  assert.equal((await request('score', { side: 'A', action: 'DECREMENT' })).status, 400);
  match.participant1_score = 10; match.participant2_score = 10;
  assert.equal((await request('complete')).status, 400); assert.equal(match.status, 'LIVE');
});
test('second participant can reach ceiling; higher score wins below ceiling', async () => {
  await request('start', { winningPoints: 21 });
  match.participant1_score = 21; match.participant2_score = 20;
  assert.equal((await request('score', { side: 'B' })).body.data.status, 'LIVE');
  assert.equal((await request('score', { side: 'B' })).status, 200);
  await request('score', { side: 'A', action: 'DECREMENT' });
  await request('score', { side: 'B', action: 'DECREMENT' });
  await request('score', { side: 'A', action: 'DECREMENT' });
  assert.equal((await request('complete')).body.data.winnerId, 'p2');
});
test('completion-eligible LIVE scores freeze increments until a decrement correction', async () => {
  await request('start', { winningPoints: 15 });
  match.participant1_score = 15; match.participant2_score = 15;
  assert.equal((await request('score', { side: 'A' })).status, 200);
  assert.equal(match.participant1_score, 16);
  assert.equal((await request('score', { side: 'A' })).status, 200);
  assert.equal(match.participant1_score, 17);
  const historyBeforeRejects = history.length;
  assert.equal((await request('score', { side: 'A' })).status, 409);
  assert.equal((await request('score', { side: 'B' })).status, 409);
  assert.equal(history.length, historyBeforeRejects);
  assert.equal(match.status, 'LIVE');
  assert.equal((await request('score', { side: 'A', action: 'DECREMENT' })).status, 200);
  assert.equal(match.participant1_score, 16);
  assert.equal((await request('score', { side: 'A' })).status, 200);
  assert.equal(match.participant1_score, 17);
});
test('manual final completion generates result and medals once', async () => {
  final = true;
  await request('start', { winningPoints: 15 });
  match.participant1_score = 15; match.participant2_score = 10;
  assert.equal((await request('complete')).status, 200);
  assert.equal(results.length, 1); assert.equal(results[0].winner_participant_id, 'p1'); assert.equal(medals.length, 2);
  assert.equal((await request('complete')).status, 200); assert.equal(results.length, 1); assert.equal(medals.length, 2);
});
test('new fixture insert explicitly leaves winning points unselected', async () => {
  await insertMatch({ query: async (sql) => { assert.match(sql, /status,winning_points/); assert.match(sql, /'SCHEDULED',NULL/); return { rows: [{}] }; } }, 'f', 't', 'c', 1, 'p1', 'PLAYER', 'p2', 'PLAYER');
});

test('retrying an already completed final repairs its missing result without changing scores', async () => {
  final = true;
  match = {...match, status:'COMPLETED', winning_points:21, participant1_score:21, participant2_score:3, winner_id:'p1'};
  const before = {...match};
  assert.equal((await request('complete')).status,200);
  assert.deepEqual(match,before);
  assert.equal(results.length,1);
  assert.equal((await request('complete')).status,200);
  assert.equal(results.length,1);
});
