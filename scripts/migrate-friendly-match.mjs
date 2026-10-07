import fs from 'node:fs';
import crypto from 'node:crypto';
import { Client } from 'pg';

const sourceMatchId = '953a812c-5d77-4895-b680-60e2abe2c7fa';
const targetTitle = 'Mobile Doubles Test - 12 Players (Migrated)';
const provenance = `Migrated from source Friendly Match ${sourceMatchId}`;
const key = 'CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE';

function readVars(path) {
  const text = fs.readFileSync(path, 'utf8');
  const line = text.split(/\r?\n/).find((value) => value.startsWith(`${key}=`));
  if (!line) throw new Error(`Missing ${key} in ${path}`);
  return line.slice(key.length + 1).trim().replace(/^['"]|['"]$/g, '');
}

function newId() { return crypto.randomUUID(); }

async function one(client, sql, params = []) {
  const result = await client.query(sql, params);
  if (result.rows.length !== 1) throw new Error(`Expected one row for: ${sql}`);
  return result.rows[0];
}

async function sourceData(client) {
  const match = await one(client, 'SELECT * FROM friendly_matches WHERE id=$1', [sourceMatchId]);
  const fixtures = (await client.query('SELECT * FROM friendly_fixtures WHERE friendly_match_id=$1 ORDER BY created_at,id', [sourceMatchId])).rows;
  const fixtureIds = fixtures.map((row) => row.id);
  const players = (await client.query(`
    SELECT DISTINCT p.* FROM player_profiles p
    WHERE p.id=$1 OR p.id IN (SELECT player_id FROM friendly_match_participants WHERE friendly_match_id=$2)
    ORDER BY p.id
  `, [match.creator_player_id, sourceMatchId])).rows;
  const users = players.length ? (await client.query('SELECT * FROM users WHERE id=ANY($1)', [players.map((row) => row.user_id).filter(Boolean)])).rows : [];
  const requests = (await client.query('SELECT * FROM friendly_match_requests WHERE friendly_match_id=$1 ORDER BY created_at,id', [sourceMatchId])).rows;
  const participants = (await client.query('SELECT * FROM friendly_match_participants WHERE friendly_match_id=$1 ORDER BY created_at,id', [sourceMatchId])).rows;
  const teams = (await client.query('SELECT * FROM friendly_match_teams WHERE friendly_match_id=$1 ORDER BY created_at,id', [sourceMatchId])).rows;
  const teamIds = teams.map((row) => row.id);
  const teamMembers = teamIds.length ? (await client.query('SELECT * FROM friendly_match_team_members WHERE team_id=ANY($1) ORDER BY id', [teamIds])).rows : [];
  const fixtureParticipants = fixtureIds.length ? (await client.query('SELECT * FROM friendly_fixture_participants WHERE fixture_id=ANY($1) ORDER BY id', [fixtureIds])).rows : [];
  const games = (await client.query('SELECT * FROM friendly_game_matches WHERE friendly_match_id=$1 ORDER BY round_number,match_number,id', [sourceMatchId])).rows;
  const gameIds = games.map((row) => row.id);
  const scoreHistory = gameIds.length ? (await client.query('SELECT * FROM friendly_match_score_history WHERE match_id=ANY($1) ORDER BY created_at,id', [gameIds])).rows : [];
  const results = (await client.query('SELECT * FROM friendly_results WHERE friendly_match_id=$1 ORDER BY created_at,id', [sourceMatchId])).rows;
  return { match, fixtures, users, players, requests, participants, teams, teamMembers, fixtureParticipants, games, scoreHistory, results };
}

async function countExisting(client) {
  const match = (await client.query('SELECT id,friendly_match_code,title,creator_player_id FROM friendly_matches WHERE title=$1 OR description=$2 ORDER BY created_at LIMIT 1', [targetTitle, provenance])).rows[0];
  if (!match) return null;
  const counts = {};
  for (const [table, where, params] of [
    ['friendly_match_participants', 'friendly_match_id=$1', [match.id]],
    ['friendly_match_requests', 'friendly_match_id=$1', [match.id]],
    ['friendly_match_teams', 'friendly_match_id=$1', [match.id]],
    ['friendly_fixtures', 'friendly_match_id=$1', [match.id]],
    ['friendly_game_matches', 'friendly_match_id=$1', [match.id]],
    ['friendly_results', 'friendly_match_id=$1', [match.id]],
  ]) counts[table] = (await client.query(`SELECT count(*)::int AS count FROM ${table} WHERE ${where}`, params)).rows[0].count;
  return { ...match, counts };
}

function printPlan(data, existing, targetCode) {
  console.log(JSON.stringify({
    SOURCE: { id: data.match.id, title: data.match.title, creator: data.match.creator_player_id, participants: data.participants.length, teams: data.teams.length, fixtures: data.fixtures.length, matches: data.games.length, completed: data.games.filter((x) => x.status === 'COMPLETED').length, live: data.games.filter((x) => x.status === 'LIVE').length, scheduled: data.games.filter((x) => x.status === 'SCHEDULED').length },
    TARGET_BEFORE: { migratedMatchExists: Boolean(existing), existingMigratedMatch: existing ?? null },
    PLANNED_ACTION: { title: targetTitle, code: targetCode, users: data.users.length, playerProfiles: data.players.length, participants: data.participants.length, teams: data.teams.length, teamMembers: data.teamMembers.length, fixtures: data.fixtures.length, fixtureParticipants: data.fixtureParticipants.length, games: data.games.length, scoreHistory: data.scoreHistory.length, results: data.results.length, existingTargetMatchTouched: false },
  }, null, 2));
}

async function run() {
  const source = new Client({ connectionString: readVars('../badminton-api-prod-deploy/.dev.vars') });
  const target = new Client({ connectionString: readVars('./.dev.vars') });
  await source.connect(); await target.connect();
  try {
    const data = await sourceData(source);
    const existing = await countExisting(target);
    if (existing) {
      printPlan(data, existing, existing.friendly_match_code);
      console.log(JSON.stringify({ migration: 'IDEMPOTENT_NOOP', migratedMatch: existing }));
      return;
    }
    const next = await target.query("SELECT COALESCE(MAX(substring(friendly_match_code FROM 5)::numeric),0)::int+1 AS n FROM friendly_matches WHERE friendly_match_code ~ '^FRND[0-9]+$'");
    const targetCode = `FRND${String(next.rows[0].n).padStart(6, '0')}`;
    printPlan(data, null, targetCode);
    await target.query('BEGIN');
    try {
      const maps = { user: new Map(), player: new Map(), team: new Map(), fixture: new Map(), fixtureParticipant: new Map(), game: new Map(), request: new Map(), participant: new Map(), teamMember: new Map(), scoreHistory: new Map(), result: new Map() };
      for (const row of data.users) {
        const stable = (await target.query('SELECT id FROM users WHERE mobile=$1 ORDER BY id LIMIT 1', [row.mobile])).rows[0];
        const id = stable?.id ?? ((await target.query('SELECT id FROM users WHERE id=$1', [row.id])).rows[0] ? newId() : row.id);
        if (!stable) await target.query('INSERT INTO users (id,mobile,role,display_name,is_active,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id,row.mobile,row.role,row.display_name,row.is_active,row.created_at,row.updated_at]);
        maps.user.set(row.id, id);
      }
      for (const row of data.players) {
        const stable = (await target.query('SELECT id FROM player_profiles WHERE mobile=$1 OR user_id=$2 ORDER BY id LIMIT 1', [row.mobile, maps.user.get(row.user_id)])).rows[0];
        const id = stable?.id ?? ((await target.query('SELECT id FROM player_profiles WHERE id=$1', [row.id])).rows[0] ? newId() : row.id);
        if (!stable) {
          const cols = ['id','player_code','user_id','full_name','gender','dob','mobile','location','playing_since','regular_player','court_academy','profile_photo_url','profile_status','created_at','updated_at'];
          await target.query(`INSERT INTO player_profiles (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, cols.map((col) => col === 'id' ? id : col === 'user_id' ? maps.user.get(row.user_id) : row[col]));
        }
        maps.player.set(row.id, id);
      }
      const migrated = await one(target, `INSERT INTO friendly_matches (id,friendly_match_code,title,description,creator_player_id,event_type,format,max_players,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [newId(), targetCode, targetTitle, `${data.match.description ?? ''}\n${provenance}`, maps.player.get(data.match.creator_player_id), data.match.event_type, data.match.format, data.match.max_players, data.match.status, data.match.created_at, data.match.updated_at]);
      for (const row of data.participants) { const id = newId(); maps.participant.set(row.id, id); await target.query('INSERT INTO friendly_match_participants (id,friendly_match_id,player_id,created_at) VALUES ($1,$2,$3,$4)', [id,migrated.id,maps.player.get(row.player_id),row.created_at]); }
      for (const row of data.requests) { const id = newId(); maps.request.set(row.id,id); await target.query('INSERT INTO friendly_match_requests (id,friendly_match_id,player_id,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6)', [id,migrated.id,maps.player.get(row.player_id),row.status,row.created_at,row.updated_at]); }
      for (const row of data.teams) { const id = newId(); maps.team.set(row.id,id); await target.query('INSERT INTO friendly_match_teams (id,friendly_match_id,team_code,created_at,updated_at) VALUES ($1,$2,$3,$4,$5)', [id,migrated.id,row.team_code,row.created_at,row.updated_at]); }
      for (const row of data.teamMembers) { const id = newId(); maps.teamMember.set(row.id,id); await target.query('INSERT INTO friendly_match_team_members (id,team_id,player_id) VALUES ($1,$2,$3)', [id,maps.team.get(row.team_id),maps.player.get(row.player_id)]); }
      for (const row of data.fixtures) { const id = newId(); maps.fixture.set(row.id,id); await target.query('INSERT INTO friendly_fixtures (id,friendly_match_id,fixture_code,format,status,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id,migrated.id,`${row.fixture_code}M`,row.format,row.status,row.created_at,row.updated_at]); }
      for (const row of data.fixtureParticipants) { const id = newId(); maps.fixtureParticipant.set(row.id,id); await target.query('INSERT INTO friendly_fixture_participants (id,fixture_id,participant_id,participant_type,seed_number,display_name) VALUES ($1,$2,$3,$4,$5,$6)', [id,maps.fixture.get(row.fixture_id),row.participant_type === 'TEAM' ? maps.team.get(row.participant_id) : maps.player.get(row.participant_id),row.participant_type,row.seed_number,row.display_name]); }
      for (const row of data.games) { const id = newId(); maps.game.set(row.id,id); await target.query('INSERT INTO friendly_game_matches (id,friendly_match_id,fixture_id,match_code,round_number,match_number,status,participant1_id,participant1_type,participant2_id,participant2_type,participant1_score,participant2_score,winning_points,winner_id,winner_type,started_at,completed_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)', [id,migrated.id,maps.fixture.get(row.fixture_id),`${row.match_code}M`,row.round_number,row.match_number,row.status,row.participant1_id ? (row.participant1_type === 'TEAM' ? maps.team.get(row.participant1_id) : maps.player.get(row.participant1_id)) : null,row.participant1_type,row.participant2_id ? (row.participant2_type === 'TEAM' ? maps.team.get(row.participant2_id) : maps.player.get(row.participant2_id)) : null,row.participant2_type,row.participant1_score,row.participant2_score,row.winning_points,row.winner_id ? (row.winner_type === 'TEAM' ? maps.team.get(row.winner_id) : maps.player.get(row.winner_id)) : null,row.winner_type,row.started_at,row.completed_at,row.created_at,row.updated_at]); }
      for (const row of data.games) await target.query('UPDATE friendly_game_matches SET source_match_1_id=$2,source_match_2_id=$3,next_match_id=$4,next_match_slot=$5 WHERE id=$1', [maps.game.get(row.id),row.source_match_1_id ? maps.game.get(row.source_match_1_id) : null,row.source_match_2_id ? maps.game.get(row.source_match_2_id) : null,row.next_match_id ? maps.game.get(row.next_match_id) : null,row.next_match_slot]);
      for (const row of data.scoreHistory) { const id = newId(); maps.scoreHistory.set(row.id,id); await target.query('INSERT INTO friendly_match_score_history (id,match_id,participant1_score,participant2_score,action,actor_player_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id,maps.game.get(row.match_id),row.participant1_score,row.participant2_score,row.action,row.actor_player_id ? maps.player.get(row.actor_player_id) : null,row.created_at]); }
      for (const row of data.results) { const id = newId(); maps.result.set(row.id,id); await target.query('INSERT INTO friendly_results (id,friendly_match_id,match_id,winner_id,winner_type,runner_up_id,runner_up_type,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id,migrated.id,maps.game.get(row.match_id),row.winner_type === 'TEAM' ? maps.team.get(row.winner_id) : maps.player.get(row.winner_id),row.winner_type,row.runner_up_id ? (row.runner_up_type === 'TEAM' ? maps.team.get(row.runner_up_id) : maps.player.get(row.runner_up_id)) : null,row.runner_up_type,row.created_at]); }
      await target.query('COMMIT');
      console.log(JSON.stringify({ migration: 'PASS', migratedMatch: { id: migrated.id, code: targetCode, title: targetTitle }, rowsInserted: { player_profiles: data.players.length, friendly_matches: 1, friendly_match_participants: data.participants.length, friendly_match_requests: data.requests.length, friendly_match_teams: data.teams.length, friendly_match_team_members: data.teamMembers.length, friendly_fixtures: data.fixtures.length, friendly_fixture_participants: data.fixtureParticipants.length, friendly_game_matches: data.games.length, friendly_match_score_history: data.scoreHistory.length, friendly_results: data.results.length } }));
    } catch (error) { await target.query('ROLLBACK'); throw error; }
  } finally { await source.end(); await target.end(); }
}
run().catch((error) => { console.error(`Friendly Match migration failed: ${error.stack ?? error.message}`); process.exitCode = 1; });
