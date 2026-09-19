import {test} from 'node:test';
import assert from 'node:assert/strict';
import {canView, RealtimeError} from '../src/services/realtime.service.js';

// Fake db.query router: branches on which table the SQL references so we can unit-test canView()
// (tournament-match lookup, then friendly-game-match fallback) without a real Postgres connection.
function fakeDb({tournamentMatch = null, friendlyMatch = null, allowed = false} = {}) {
  return {
    query: async (sql) => {
      if (/FROM matches m JOIN tournaments/.test(sql)) return {rows: tournamentMatch ? [tournamentMatch] : []};
      if (/FROM friendly_game_matches gm JOIN friendly_matches fm ON fm\.id=gm\.friendly_match_id WHERE gm\.id/.test(sql) && !/allowed|EXISTS/.test(sql)) {
        return {rows: friendlyMatch ? [friendlyMatch] : []};
      }
      // Both the tournament and friendly "allowed" EXISTS-check queries share the generic WHERE m.id=$1/gm.id=$1 shape;
      // any query beyond the two lookups above is treated as the allowed-check.
      return {rows: allowed ? [{'?column?': 1}] : []};
    },
  };
}

test('canView: 404s when the match id exists in neither tournament nor friendly tables', async () => {
  const db = fakeDb();
  await assert.rejects(() => canView(db, 'missing', {sub: 'u1', role: 'PLAYER'}), (e) => e instanceof RealtimeError && e.status === 404);
});

test('canView: tournament match found — requires authentication', async () => {
  const db = fakeDb({tournamentMatch: {id: 'm1', organizer_id: 'org1'}});
  await assert.rejects(() => canView(db, 'm1', null), (e) => e instanceof RealtimeError && e.status === 401);
});

test('canView: tournament match — ADMIN always allowed', async () => {
  const db = fakeDb({tournamentMatch: {id: 'm1', organizer_id: 'org1'}});
  const result = await canView(db, 'm1', {sub: 'admin1', role: 'ADMIN'});
  assert.equal(result.id, 'm1');
});

test('canView: tournament match — owning ORGANIZER allowed, non-owning ORGANIZER rejected', async () => {
  const db = fakeDb({tournamentMatch: {id: 'm1', organizer_id: 'org1'}});
  const ok = await canView(db, 'm1', {sub: 'org1', role: 'ORGANIZER'});
  assert.equal(ok.id, 'm1');
  await assert.rejects(() => canView(db, 'm1', {sub: 'org2', role: 'ORGANIZER'}), (e) => e instanceof RealtimeError && e.status === 403);
});

test('canView: falls back to friendly game match when no tournament match exists', async () => {
  const db = fakeDb({friendlyMatch: {id: 'g1', creator_player_id: 'p1'}, allowed: true});
  const result = await canView(db, 'g1', {sub: 'u1', role: 'PLAYER'});
  assert.equal(result.id, 'g1');
});

test('canView: friendly game match — PLAYER not a creator/participant is rejected', async () => {
  const db = fakeDb({friendlyMatch: {id: 'g1', creator_player_id: 'p1'}, allowed: false});
  await assert.rejects(() => canView(db, 'g1', {sub: 'stranger', role: 'PLAYER'}), (e) => e instanceof RealtimeError && e.status === 403);
});

test('canView: friendly game match — ORGANIZER role is rejected (friendly domain has no organizer)', async () => {
  const db = fakeDb({friendlyMatch: {id: 'g1', creator_player_id: 'p1'}, allowed: true});
  await assert.rejects(() => canView(db, 'g1', {sub: 'u1', role: 'ORGANIZER'}), (e) => e instanceof RealtimeError && e.status === 403);
});

test('canView: friendly game match — ADMIN always allowed', async () => {
  const db = fakeDb({friendlyMatch: {id: 'g1', creator_player_id: 'p1'}, allowed: false});
  const result = await canView(db, 'g1', {sub: 'admin1', role: 'ADMIN'});
  assert.equal(result.id, 'g1');
});
