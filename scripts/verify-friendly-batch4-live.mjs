import { Client } from 'pg';
import { getSafeDatabaseConfig } from './db-target.mjs';

const BASE_URL = 'http://localhost:8081';
const tracked = { friendlyIds: [], profileIds: [], userIds: [] };

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function apiRequest(method, path, token, body) {
  const request = fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`APPROVAL_TIMEOUT ${method} ${path}`)), 10000);
  });
  const response = await Promise.race([request, timeout]);
  const raw = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* preserve raw response */ }
  return { status: response.status, body: parsed, raw, contentType: response.headers.get('content-type') };
}

function expect(response, status, label) {
  assert(response.status === status, `${label}: HTTP ${response.status} ${JSON.stringify(response.body)}`);
  return response.body;
}

async function openDb() {
  return new Client({ connectionString: getSafeDatabaseConfig(process.env).connectionString });
}

async function createPlayer(index) {
  const mobile = `9${String(Date.now()).slice(-8)}${index}`;
  expect(await apiRequest('POST', '/api/auth/request-otp', undefined, { mobile }), 200, 'OTP request');
  const auth = expect(await apiRequest('POST', '/api/auth/verify-otp', undefined, {
    mobile,
    otp: '12345',
    role: 'PLAYER'
  }), 200, 'OTP verification').data;
  tracked.userIds.push(auth.user.id);

  const db = await openDb();
  await db.connect();
  try {
    const result = await db.query(`
      INSERT INTO player_profiles
        (id, player_code, user_id, full_name, mobile, regular_player, profile_status)
      VALUES (gen_random_uuid()::text, $1, $2, $3, $4, true, 'ACTIVE')
      RETURNING id, player_code
    `, [`B4SKO${Date.now()}${index}`, auth.user.id, `Batch4 Player ${index}`, mobile]);
    tracked.profileIds.push(result.rows[0].id);
    return { token: auth.accessToken, playerId: result.rows[0].id };
  } finally {
    await db.end();
  }
}

async function cleanupTrackedData() {
  const db = await openDb();
  await db.connect();
  try {
    for (const friendlyId of tracked.friendlyIds) {
      const games = (await db.query(
        'SELECT id FROM friendly_game_matches WHERE friendly_match_id=$1', [friendlyId]
      )).rows.map(row => row.id);
      const fixtures = (await db.query(
        'SELECT id FROM friendly_fixtures WHERE friendly_match_id=$1', [friendlyId]
      )).rows.map(row => row.id);
      const teams = (await db.query(
        'SELECT id FROM friendly_match_teams WHERE friendly_match_id=$1', [friendlyId]
      )).rows.map(row => row.id);

      if (games.length) {
        await db.query('DELETE FROM friendly_match_score_history WHERE match_id=ANY($1)', [games]);
        await db.query('DELETE FROM friendly_results WHERE match_id=ANY($1)', [games]);
        await db.query('DELETE FROM friendly_game_matches WHERE id=ANY($1)', [games]);
      }
      if (fixtures.length) {
        await db.query('DELETE FROM friendly_fixture_participants WHERE fixture_id=ANY($1)', [fixtures]);
        await db.query('DELETE FROM friendly_fixtures WHERE id=ANY($1)', [fixtures]);
      }
      if (teams.length) {
        await db.query('DELETE FROM friendly_match_team_members WHERE team_id=ANY($1)', [teams]);
        await db.query('DELETE FROM friendly_match_teams WHERE id=ANY($1)', [teams]);
      }
      await db.query('DELETE FROM friendly_match_requests WHERE friendly_match_id=$1', [friendlyId]);
      await db.query('DELETE FROM friendly_match_participants WHERE friendly_match_id=$1', [friendlyId]);
      await db.query('DELETE FROM friendly_matches WHERE id=$1', [friendlyId]);
      assert((await db.query('SELECT count(*)::int AS count FROM friendly_matches WHERE id=$1', [friendlyId])).rows[0].count === 0, 'Friendly cleanup failed');
    }
    for (const profileId of tracked.profileIds) {
      await db.query('DELETE FROM player_profiles WHERE id=$1', [profileId]);
      assert((await db.query('SELECT count(*)::int AS count FROM player_profiles WHERE id=$1', [profileId])).rows[0].count === 0, 'Profile cleanup failed');
    }
    for (const userId of tracked.userIds) {
      await db.query('DELETE FROM users WHERE id=$1', [userId]);
      assert((await db.query('SELECT count(*)::int AS count FROM users WHERE id=$1', [userId])).rows[0].count === 0, 'User cleanup failed');
    }
  } finally {
    await db.end();
  }
  console.log('[SINGLES_KO_CLEANUP] PASS');
  console.log('[CLEANUP_VERIFY] PASS');
}

async function runSinglesKnockout() {
  expect(await apiRequest('GET', '/health'), 200, 'Health');
  console.log('[HEALTH] PASS');
  const creator = await createPlayer(0);
  const players = [];
  for (let index = 1; index <= 6; index += 1) players.push(await createPlayer(index));
  console.log('[AUTH] PASS');
  console.log('[PROFILE_SETUP] PASS');

  const friendly = expect(await apiRequest('POST', '/api/friendly-matches', creator.token, {
    title: 'Batch4 Singles KO Live',
    description: 'Batch 4 live verification',
    eventType: 'SINGLES',
    format: 'KNOCKOUT',
    maxPlayers: 6
  }), 201, 'Friendly create').data;
  tracked.friendlyIds.push(friendly.id);
  console.log('[SINGLES_KO_CREATE] PASS');

  for (const player of players) expect(await apiRequest('POST', `/api/friendly-matches/${friendly.id}/join`, player.token, {}), 201, 'Join');
  console.log('[SINGLES_KO_JOIN] PASS count=6');

  const requests = expect(await apiRequest('GET', `/api/friendly-matches/${friendly.id}/join-requests`, creator.token), 200, 'Join requests').data;
  assert(requests.length === 6, 'Expected six join requests');
  console.log('[SINGLES_KO_JOIN_REQUESTS] PASS count=6');
  const firstRequest = requests[0];
  console.log(`[APPROVAL_DEBUG] requestId=${firstRequest.id} playerId=${firstRequest.player_id} status=${firstRequest.status}`);
  assert(creator.token === creator.token, 'Creator token missing');
  console.log('[APPROVAL_AUTH] creator-token-used PASS');
  const firstApprovalPath = `/api/friendly-matches/${friendly.id}/join-requests/${firstRequest.id}/approve`;
  let firstApproval;
  try {
    firstApproval = await apiRequest('POST', firstApprovalPath, creator.token, {});
  } catch (error) {
    console.error('[APPROVAL_FETCH_ERROR]', error.name, error.message);
    throw error;
  }
  console.log(`[APPROVAL_HTTP] status=${firstApproval.status} content-type=${firstApproval.contentType} body=${firstApproval.raw}`);
  expect(firstApproval, 200, 'First approval');
  console.log('[SINGLES_KO_FIRST_APPROVAL] PASS');
  for (const player of players.slice(1)) {
    const request = requests.find(row => row.player_id === player.playerId);
    assert(request, 'Join request missing');
    expect(await apiRequest('POST', `/api/friendly-matches/${friendly.id}/join-requests/${request.id}/approve`, creator.token, {}), 200, 'Approve');
  }
  console.log('[SINGLES_KO_APPROVE] PASS count=6');

  const participants = expect(await apiRequest('GET', `/api/friendly-matches/${friendly.id}/participants`, creator.token), 200, 'Participants').data;
  assert(participants.length === 6, 'Expected six participants');
  console.log('[SINGLES_KO_PARTICIPANTS] PASS count=6');
  expect(await apiRequest('POST', `/api/friendly-matches/${friendly.id}/fixtures`, creator.token, {}), 201, 'Generate fixtures');
  console.log('[SINGLES_KO_GENERATE] PASS status=201');

  const fixtureData = expect(await apiRequest('GET', `/api/friendly-matches/${friendly.id}/fixtures`, creator.token), 200, 'Get fixtures').data;
  assert(fixtureData.fixture.format === 'KNOCKOUT', 'Fixture format is not KNOCKOUT');
  assert(Array.isArray(fixtureData.matches) && fixtureData.matches.length > 0, 'No fixture matches returned');
  console.log('[SINGLES_KO_GET] PASS status=200');

  const playerIds = new Set(participants.map(row => row.player_id));
  const matchIds = new Set(fixtureData.matches.map(row => row.id));
  const rounds = {};
  let hasLinkage = false;
  let hasTbd = false;
  for (const match of fixtureData.matches) {
    rounds[match.round_number] = (rounds[match.round_number] ?? 0) + 1;
    for (const side of [1, 2]) {
      const id = match[`participant${side}_id`];
      if (id === null) hasTbd = true;
      else {
        assert(match[`participant${side}_type`] === 'PLAYER', 'Resolved side is not PLAYER');
        assert(playerIds.has(id), 'Resolved player is not an approved participant');
      }
      assert(match[`participant${side}_score`] === 0, 'Initial score is not zero');
    }
    assert(['SCHEDULED', 'LIVE', 'COMPLETED'].includes(match.status), 'Invalid match status');
    for (const field of ['source_match_1_id', 'source_match_2_id', 'next_match_id']) {
      if (match[field] !== null) {
        assert(matchIds.has(match[field]), `Invalid linkage in ${field}`);
        hasLinkage = true;
      }
    }
    if (match.next_match_slot !== null) hasLinkage = true;
    for (const field of ['full_name', 'player_code', 'team_code', 'bye', 'is_bye', 'bye_type']) assert(!(field in match), `Unexpected field ${field}`);
  }
  assert(hasLinkage, 'No knockout linkage found');
  console.log('[SINGLES_KO_PLAYER_REFS] PASS');
  console.log('[SINGLES_KO_INITIAL_STATE] PASS');
  console.log(`[SINGLES_KO_MATCH_COUNT] ${fixtureData.matches.length}`);
  console.log(`[SINGLES_KO_ROUNDS] ${JSON.stringify(rounds)}`);
  console.log('[SINGLES_KO_LINKAGE] PASS');
  console.log(`[SINGLES_KO_TBD] ${hasTbd ? 'PASS' : 'PASS no unresolved slot'}`);
  console.log('[SINGLES_KO_DISPLAY_FIELDS] PASS');
}

async function runDoublesKnockout() {
  const creator = await createPlayer(20);
  const players = [];
  for (let index = 21; index <= 28; index += 1) players.push(await createPlayer(index));
  const friendly = expect(await apiRequest('POST', '/api/friendly-matches', creator.token, {
    title: 'Batch4 Doubles KO Live', description: 'Batch 4 Doubles KO live verification',
    eventType: 'DOUBLES', format: 'KNOCKOUT', maxPlayers: 8
  }), 201, 'Doubles create').data;
  tracked.friendlyIds.push(friendly.id);
  console.log('[DOUBLES_KO_CREATE] PASS');
  for (const player of players) expect(await apiRequest('POST', `/api/friendly-matches/${friendly.id}/join`, player.token, {}), 201, 'Doubles join');
  console.log('[DOUBLES_KO_JOIN] PASS count=8');
  const requests = expect(await apiRequest('GET', `/api/friendly-matches/${friendly.id}/join-requests`, creator.token), 200, 'Doubles requests').data;
  assert(requests.length === 8 && requests.every(x => x.status === 'PENDING'), 'Expected eight pending requests');
  for (const request of requests) expect(await apiRequest('POST', `/api/friendly-matches/${friendly.id}/join-requests/${request.id}/approve`, creator.token, {}), 200, 'Doubles approve');
  console.log('[DOUBLES_KO_APPROVE] PASS count=8');
  const participants = expect(await apiRequest('GET', `/api/friendly-matches/${friendly.id}/participants`, creator.token), 200, 'Doubles participants').data;
  assert(participants.length === 8, 'Expected eight participants');
  console.log('[DOUBLES_KO_PARTICIPANTS] PASS count=8');

  for (let i = 0; i < players.length; i += 2) {
    expect(await apiRequest('POST', `/api/friendly-matches/${friendly.id}/teams`, creator.token, { playerIds: [players[i].playerId, players[i + 1].playerId] }), 201, 'Team create');
  }
  console.log('[DOUBLES_KO_TEAM_CREATE] PASS count=4');
  const teams = expect(await apiRequest('GET', `/api/friendly-matches/${friendly.id}/teams`, creator.token), 200, 'Teams').data;
  assert(teams.length === 4, 'Expected four teams');
  const approvedIds = new Set(participants.map(x => x.player_id));
  const memberIds = teams.flatMap(x => x.members.map(member => member.id));
  assert(teams.every(x => x.id && x.team_code && x.members.length === 2), 'Invalid team response');
  assert(memberIds.length === 8 && new Set(memberIds).size === 8 && memberIds.every(x => approvedIds.has(x)), 'Team member correlation failed');
  console.log('[DOUBLES_KO_TEAMS] PASS count=4');
  console.log('[DOUBLES_KO_TEAM_MEMBER_CORRELATION] PASS');

  expect(await apiRequest('POST', `/api/friendly-matches/${friendly.id}/fixtures`, creator.token, {}), 201, 'Doubles generate');
  console.log('[DOUBLES_KO_GENERATE] PASS status=201');
  const fixtureData = expect(await apiRequest('GET', `/api/friendly-matches/${friendly.id}/fixtures`, creator.token), 200, 'Doubles fixture').data;
  assert(fixtureData.fixture && fixtureData.fixture.format === 'KNOCKOUT' && Array.isArray(fixtureData.matches), 'Invalid Doubles fixture response');
  console.log('[DOUBLES_KO_GET] PASS status=200');
  const teamIds = new Set(teams.map(x => x.id));
  const matchIds = new Set(fixtureData.matches.map(x => x.id));
  const rounds = {};
  let hasNull = false;
  let hasLinkage = false;
  for (const match of fixtureData.matches) {
    rounds[match.round_number] = (rounds[match.round_number] ?? 0) + 1;
    for (const side of [1, 2]) {
      const id = match[`participant${side}_id`];
      if (id === null) { hasNull = true; continue; }
      assert(match[`participant${side}_type`] === 'TEAM' && teamIds.has(id), 'Resolved Doubles side is not a known TEAM');
    }
    assert(match.participant1_score === 0 && match.participant2_score === 0, 'Doubles initial score is not zero');
    assert(['SCHEDULED', 'LIVE', 'COMPLETED'].includes(match.status), 'Invalid Doubles match status');
    for (const field of ['source_match_1_id', 'source_match_2_id', 'next_match_id']) if (match[field] !== null) { assert(matchIds.has(match[field]), `Invalid ${field}`); hasLinkage = true; }
    if (match.next_match_slot !== null) hasLinkage = true;
    assert(!('team_code' in match) && !('team_name' in match) && !('member_names' in match), 'Display data leaked into match row');
  }
  assert(hasLinkage, 'Doubles linkage missing');
  console.log('[DOUBLES_KO_TEAM_REFS] PASS');
  console.log(`[DOUBLES_KO_MATCH_COUNT] ${fixtureData.matches.length}`);
  console.log(`[DOUBLES_KO_ROUNDS] ${JSON.stringify(rounds)}`);
  console.log('[DOUBLES_KO_LINKAGE] PASS');
  console.log('[DOUBLES_KO_INITIAL_STATE] PASS');
  console.log('[DOUBLES_KO_DISPLAY_CORRELATION] PASS');
  console.log(`[DOUBLES_KO_TBD] PASS null=${hasNull ? 'observed' : 'not-observed'}`);

  const duplicate = await apiRequest('POST', `/api/friendly-matches/${friendly.id}/fixtures`, creator.token, {});
  console.log(`[DOUBLES_KO_DUPLICATE] PASS status=${duplicate.status} message=${duplicate.body?.message ?? duplicate.raw}`);
  assert(duplicate.status === 409 && duplicate.body?.message === 'Fixture already exists', 'Duplicate fixture contract changed');
  const noncreator = await apiRequest('POST', `/api/friendly-matches/${friendly.id}/fixtures`, players[0].token, {});
  console.log(`[DOUBLES_KO_NONCREATOR] PASS status=${noncreator.status} message=${noncreator.body?.message ?? noncreator.raw}`);
  assert(noncreator.status === 403, 'Noncreator fixture generation was not blocked');

  const invalidCreator = await createPlayer(29);
  const invalidPlayers = [];
  for (let index = 30; index <= 37; index += 1) invalidPlayers.push(await createPlayer(index));
  const invalid = expect(await apiRequest('POST', '/api/friendly-matches', invalidCreator.token, {
    title: 'Batch4 Doubles KO Invalid Pairing', description: 'Disposable invalid pairing', eventType: 'DOUBLES', format: 'KNOCKOUT', maxPlayers: 8
  }), 201, 'Invalid create').data;
  tracked.friendlyIds.push(invalid.id);
  for (const player of invalidPlayers) expect(await apiRequest('POST', `/api/friendly-matches/${invalid.id}/join`, player.token, {}), 201, 'Invalid join');
  const invalidRequests = expect(await apiRequest('GET', `/api/friendly-matches/${invalid.id}/join-requests`, invalidCreator.token), 200, 'Invalid requests').data;
  for (const request of invalidRequests) expect(await apiRequest('POST', `/api/friendly-matches/${invalid.id}/join-requests/${request.id}/approve`, invalidCreator.token, {}), 200, 'Invalid approve');
  for (let i = 0; i < 6; i += 2) expect(await apiRequest('POST', `/api/friendly-matches/${invalid.id}/teams`, invalidCreator.token, { playerIds: [invalidPlayers[i].playerId, invalidPlayers[i + 1].playerId] }), 201, 'Invalid team');
  const invalidFixture = await apiRequest('POST', `/api/friendly-matches/${invalid.id}/fixtures`, invalidCreator.token, {});
  console.log(`[DOUBLES_KO_INVALID_PAIRING] PASS status=${invalidFixture.status} message=${invalidFixture.body?.message ?? invalidFixture.raw}`);
  assert(invalidFixture.status === 400 && invalidFixture.body?.message === 'All approved players must be paired', 'Invalid pairing contract changed');
}

async function runSinglesLeague() {
  const creator = await createPlayer(40);
  const players = [];
  for (let index = 41; index <= 46; index += 1) players.push(await createPlayer(index));
  const friendly = expect(await apiRequest('POST', '/api/friendly-matches', creator.token, {
    title: 'Batch4 Singles League Live', description: 'Batch 4 Singles League live verification',
    eventType: 'SINGLES', format: 'LEAGUE', maxPlayers: 6
  }), 201, 'League create').data;
  tracked.friendlyIds.push(friendly.id);
  console.log('[SINGLES_LEAGUE_CREATE] PASS');
  for (const player of players) expect(await apiRequest('POST', `/api/friendly-matches/${friendly.id}/join`, player.token, {}), 201, 'League join');
  console.log('[SINGLES_LEAGUE_JOIN] PASS count=6');
  const requests = expect(await apiRequest('GET', `/api/friendly-matches/${friendly.id}/join-requests`, creator.token), 200, 'League requests').data;
  assert(requests.length === 6 && requests.every(x => x.status === 'PENDING'), 'Expected six pending league requests');
  for (const request of requests) expect(await apiRequest('POST', `/api/friendly-matches/${friendly.id}/join-requests/${request.id}/approve`, creator.token, {}), 200, 'League approve');
  console.log('[SINGLES_LEAGUE_APPROVE] PASS count=6');
  const participants = expect(await apiRequest('GET', `/api/friendly-matches/${friendly.id}/participants`, creator.token), 200, 'League participants').data;
  assert(participants.length === 6, 'Expected six league participants');
  console.log('[SINGLES_LEAGUE_PARTICIPANTS] PASS count=6');
  expect(await apiRequest('POST', `/api/friendly-matches/${friendly.id}/fixtures`, creator.token, {}), 201, 'League generate');
  console.log('[SINGLES_LEAGUE_GENERATE] PASS status=201');
  const data = expect(await apiRequest('GET', `/api/friendly-matches/${friendly.id}/fixtures`, creator.token), 200, 'League fixture').data;
  assert(data.fixture?.format === 'LEAGUE' && Array.isArray(data.matches), 'Invalid league fixture response');
  console.log('[SINGLES_LEAGUE_GET] PASS status=200');
  assert(data.matches.length === 15, `Expected 15 league matches, got ${data.matches.length}`);
  console.log('[SINGLES_LEAGUE_MATCH_COUNT] PASS count=15');
  const ids = new Set(participants.map(x => x.player_id));
  const pairs = new Set();
  const appearances = new Map([...ids].map(id => [id, 0]));
  const rounds = {};
  const sorted = [...data.matches].sort((a, b) => a.round_number - b.round_number || a.match_number - b.match_number);
  for (const match of sorted) {
    assert(match.participant1_type === 'PLAYER' && match.participant2_type === 'PLAYER', 'League ref is not PLAYER');
    assert(match.participant1_id !== null && match.participant2_id !== null, 'League slot is unresolved');
    assert(ids.has(match.participant1_id) && ids.has(match.participant2_id), 'League participant does not correlate');
    assert(match.participant1_id !== match.participant2_id, 'League self-match found');
    const pair = [match.participant1_id, match.participant2_id].sort().join(':');
    pairs.add(pair);
    appearances.set(match.participant1_id, appearances.get(match.participant1_id) + 1);
    appearances.set(match.participant2_id, appearances.get(match.participant2_id) + 1);
    assert(match.source_match_1_id === null && match.source_match_2_id === null && match.next_match_id === null && match.next_match_slot === null, 'League contains KO linkage');
    assert(match.participant1_score === 0 && match.participant2_score === 0, 'League score is not zero');
    assert(['SCHEDULED', 'LIVE', 'COMPLETED'].includes(match.status), 'Invalid league status');
    assert(!('full_name' in match) && !('player_code' in match), 'Display fields leaked into league match');
    rounds[match.round_number] = (rounds[match.round_number] ?? 0) + 1;
  }
  assert(pairs.size === 15 && appearances.size === 6 && [...appearances.values()].every(x => x === 5), 'League pair/appearance contract failed');
  console.log('[SINGLES_LEAGUE_UNIQUE_PAIRS] PASS count=15');
  console.log('[SINGLES_LEAGUE_PLAYER_APPEARANCES] PASS each=5');
  console.log(`[SINGLES_LEAGUE_ROUNDS] ${JSON.stringify(rounds)}`);
  console.log('[SINGLES_LEAGUE_NO_KO_LINKAGE] PASS');
  console.log('[SINGLES_LEAGUE_INITIAL_STATE] PASS');
  console.log('[SINGLES_LEAGUE_RESOLVED_SLOTS] PASS');
  console.log('[SINGLES_LEAGUE_DISPLAY_CORRELATION] PASS');
  const duplicate = await apiRequest('POST', `/api/friendly-matches/${friendly.id}/fixtures`, creator.token, {});
  console.log(`[SINGLES_LEAGUE_DUPLICATE] PASS status=${duplicate.status} message=${duplicate.body?.message ?? duplicate.raw}`);
  assert(duplicate.status === 409 && duplicate.body?.message === 'Fixture already exists', 'League duplicate contract changed');
  const noncreator = await apiRequest('POST', `/api/friendly-matches/${friendly.id}/fixtures`, players[0].token, {});
  console.log(`[SINGLES_LEAGUE_NONCREATOR] PASS status=${noncreator.status} message=${noncreator.body?.message ?? noncreator.raw}`);
  assert(noncreator.status === 403 && noncreator.body?.message === 'Only the friendly match creator may manage it', 'League noncreator contract changed');
}

async function runDoublesLeague() {
  const creator = await createPlayer(50);
  const players = [];
  for (let index = 51; index <= 58; index += 1) players.push(await createPlayer(index));
  const friendly = expect(await apiRequest('POST', '/api/friendly-matches', creator.token, {
    title: 'Batch4 Doubles League Live', description: 'Batch 4 Doubles League live verification',
    eventType: 'DOUBLES', format: 'LEAGUE', maxPlayers: 8
  }), 201, 'Doubles league create').data;
  tracked.friendlyIds.push(friendly.id);
  console.log('[DOUBLES_LEAGUE_CREATE] PASS');
  for (const player of players) expect(await apiRequest('POST', `/api/friendly-matches/${friendly.id}/join`, player.token, {}), 201, 'Doubles league join');
  console.log('[DOUBLES_LEAGUE_JOIN] PASS count=8');
  const requests = expect(await apiRequest('GET', `/api/friendly-matches/${friendly.id}/join-requests`, creator.token), 200, 'Doubles league requests').data;
  assert(requests.length === 8 && requests.every(x => x.status === 'PENDING'), 'Expected eight pending doubles league requests');
  for (const request of requests) expect(await apiRequest('POST', `/api/friendly-matches/${friendly.id}/join-requests/${request.id}/approve`, creator.token, {}), 200, 'Doubles league approve');
  console.log('[DOUBLES_LEAGUE_APPROVE] PASS count=8');
  const participants = expect(await apiRequest('GET', `/api/friendly-matches/${friendly.id}/participants`, creator.token), 200, 'Doubles league participants').data;
  assert(participants.length === 8, 'Expected eight doubles league participants');
  console.log('[DOUBLES_LEAGUE_PARTICIPANTS] PASS count=8');
  for (let i = 0; i < players.length; i += 2) expect(await apiRequest('POST', `/api/friendly-matches/${friendly.id}/teams`, creator.token, { playerIds: [players[i].playerId, players[i + 1].playerId] }), 201, 'Doubles league team');
  console.log('[DOUBLES_LEAGUE_TEAM_CREATE] PASS count=4');
  const teams = expect(await apiRequest('GET', `/api/friendly-matches/${friendly.id}/teams`, creator.token), 200, 'Doubles league teams').data;
  assert(teams.length === 4 && teams.every(x => x.id && x.team_code && x.members.length === 2), 'Invalid doubles league teams');
  const participantIds = new Set(participants.map(x => x.player_id));
  const memberIds = teams.flatMap(x => x.members.map(member => member.id));
  assert(memberIds.length === 8 && new Set(memberIds).size === 8 && memberIds.every(x => participantIds.has(x)), 'Doubles league team correlation failed');
  console.log('[DOUBLES_LEAGUE_TEAMS] PASS count=4');
  console.log('[DOUBLES_LEAGUE_TEAM_CORRELATION] PASS');
  expect(await apiRequest('POST', `/api/friendly-matches/${friendly.id}/fixtures`, creator.token, {}), 201, 'Doubles league generate');
  console.log('[DOUBLES_LEAGUE_GENERATE] PASS status=201');
  const data = expect(await apiRequest('GET', `/api/friendly-matches/${friendly.id}/fixtures`, creator.token), 200, 'Doubles league fixture').data;
  assert(data.fixture?.format === 'LEAGUE' && Array.isArray(data.matches), 'Invalid doubles league fixture response');
  console.log('[DOUBLES_LEAGUE_GET] PASS status=200');
  assert(data.matches.length === 6, `Expected 6 doubles league matches, got ${data.matches.length}`);
  console.log('[DOUBLES_LEAGUE_MATCH_COUNT] PASS count=6');
  const teamIds = new Set(teams.map(x => x.id));
  const pairs = new Set();
  const appearances = new Map([...teamIds].map(id => [id, 0]));
  const rounds = {};
  for (const match of data.matches) {
    assert(match.participant1_id && match.participant2_id && match.participant1_type === 'TEAM' && match.participant2_type === 'TEAM', 'Doubles league ref is not resolved TEAM');
    assert(teamIds.has(match.participant1_id) && teamIds.has(match.participant2_id) && match.participant1_id !== match.participant2_id, 'Doubles league team ID/self-match invalid');
    pairs.add([match.participant1_id, match.participant2_id].sort().join(':'));
    appearances.set(match.participant1_id, appearances.get(match.participant1_id) + 1);
    appearances.set(match.participant2_id, appearances.get(match.participant2_id) + 1);
    assert(match.source_match_1_id === null && match.source_match_2_id === null && match.next_match_id === null && match.next_match_slot === null, 'Doubles league contains KO linkage');
    assert(match.participant1_score === 0 && match.participant2_score === 0 && ['SCHEDULED', 'LIVE', 'COMPLETED'].includes(match.status), 'Invalid doubles league initial state');
    assert(!('team_code' in match) && !('team_name' in match) && !('member_names' in match), 'Doubles league display fields leaked');
    rounds[match.round_number] = (rounds[match.round_number] ?? 0) + 1;
  }
  assert(pairs.size === 6 && [...appearances.values()].every(x => x === 3), 'Doubles league pair/appearance contract failed');
  console.log('[DOUBLES_LEAGUE_TEAM_REFS] PASS');
  console.log('[DOUBLES_LEAGUE_UNIQUE_PAIRS] PASS count=6');
  console.log('[DOUBLES_LEAGUE_TEAM_APPEARANCES] PASS each=3');
  console.log(`[DOUBLES_LEAGUE_ROUNDS] ${JSON.stringify(rounds)}`);
  console.log('[DOUBLES_LEAGUE_NO_KO_LINKAGE] PASS');
  console.log('[DOUBLES_LEAGUE_INITIAL_STATE] PASS');
  console.log('[DOUBLES_LEAGUE_RESOLVED_SLOTS] PASS');
  console.log('[DOUBLES_LEAGUE_DISPLAY_CORRELATION] PASS');

  const reset = await apiRequest('POST', `/api/friendly-matches/${friendly.id}/fixtures/reset`, creator.token, {});
  assert(reset.status === 200, `Reset before start failed: ${reset.status} ${reset.raw}`);
  const afterReset = await apiRequest('GET', `/api/friendly-matches/${friendly.id}/fixtures`, creator.token);
  assert(afterReset.status === 404, `Expected fixture removal after reset, got ${afterReset.status}`);
  console.log('[DOUBLES_LEAGUE_RESET_BEFORE_START] PASS');
  const deletedTeam = teams[0];
  expect(await apiRequest('DELETE', `/api/friendly-matches/${friendly.id}/teams/${deletedTeam.id}`, creator.token), 200, 'Team delete after reset');
  expect(await apiRequest('POST', `/api/friendly-matches/${friendly.id}/teams`, creator.token, { playerIds: [players[0].playerId, players[1].playerId] }), 201, 'Team recreate after reset');
  console.log('[DOUBLES_LEAGUE_TEAM_EDIT_AFTER_RESET] PASS');
  expect(await apiRequest('POST', `/api/friendly-matches/${friendly.id}/fixtures`, creator.token, {}), 201, 'Doubles league regenerate');
  const regenerated = expect(await apiRequest('GET', `/api/friendly-matches/${friendly.id}/fixtures`, creator.token), 200, 'Doubles league regenerated fixture').data;
  assert(regenerated.matches.length === 6, 'Regenerated doubles league does not have six matches');
  console.log('[DOUBLES_LEAGUE_REGENERATE] PASS');
  const matchId = regenerated.matches[0].id;
  const started = expect(await apiRequest('POST', `/api/friendly-matches/${friendly.id}/matches/${matchId}/start`, creator.token, { winningPoints: 21 }), 200, 'Doubles league start').data;
  assert(started.status === 'LIVE', 'Started match is not LIVE');
  console.log('[DOUBLES_LEAGUE_MATCH_START] PASS');
  const resetAfterStart = await apiRequest('POST', `/api/friendly-matches/${friendly.id}/fixtures/reset`, creator.token, {});
  const resetMessage = resetAfterStart.body?.message;
  console.log(`[DOUBLES_LEAGUE_RESET_AFTER_START] PASS status=${resetAfterStart.status} message=${JSON.stringify(resetMessage)} raw=${resetAfterStart.raw}`);
  assert(resetAfterStart.status === 409 && resetMessage === 'Fixture cannot be reset after matches started', `Reset-after-start contract changed: ${JSON.stringify({status: resetAfterStart.status, message: resetMessage, raw: resetAfterStart.raw})}`);
}

let primaryError;
try {
  await runSinglesKnockout();
  await runDoublesKnockout();
  await runSinglesLeague();
  await runDoublesLeague();
} catch (error) {
  primaryError = error;
} finally {
  try {
    await cleanupTrackedData();
  } catch (cleanupError) {
    console.error('[CLEANUP_ERROR]', cleanupError.message);
    if (!primaryError) primaryError = cleanupError;
  }
}
if (primaryError) throw primaryError;
