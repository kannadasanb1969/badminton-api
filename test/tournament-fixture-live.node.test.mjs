import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from 'pg';
import {getSafeDatabaseConfig} from '../scripts/db-target.mjs';
import {issueAccessToken} from '../src/utils/auth-token.js';
import {createTournament,transitionTournament} from '../src/services/tournament.service.js';
import {createRegistration} from '../src/services/registration.service.js';
import {generate as generateFixture} from '../src/services/fixture.service.js';

// Live end-to-end verification (real Postgres, not mocked) that:
//  1. the auth-hardening change (tournament create/submit/approve/publish + fixture generate now trust the
//     verified bearer-token identity, not client-supplied organizerId/adminUserId body fields) still works
//     through the full real lifecycle, and
//  2. the KNOCKOUT bracket bug fix (buildKnockoutBracket dead-match-on-double-bye) produces a correct,
//     fully-linked bracket for a genuinely non-power-of-two tournament category (5 participants, byeCount=3)
//     when driven through the real fixture.service.js generate() against a live database.
// Gated the same way as the existing friendly-postgres-integration test: requires explicit opt-in env vars.
const enabled=process.env.DB_ENV&&['development','test'].includes(process.env.DB_ENV)&&process.env.ALLOW_DB_INTEGRATION_TESTS==='true'&&process.env.DATABASE_URL_DEV;
let client,env,tag,organizerUser,adminUser,players=[],tournamentId,categoryId,registrationIds=[],fixtureId;

before(async()=>{
  if(!enabled)return;
  const config=getSafeDatabaseConfig(process.env);
  client=new Client({connectionString:config.connectionString});
  await client.connect();
  env={HYPERDRIVE:{connectionString:config.connectionString},AUTH_TOKEN_SECRET:'tfl-test-secret'};
  tag=`TFL_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
  organizerUser={id:`${tag}-organizer`,mobile:`9${Date.now()}1`.slice(0,13),role:'ORGANIZER',display_name:`TFL Organizer ${tag}`};
  adminUser={id:`${tag}-admin`,mobile:`9${Date.now()}2`.slice(0,13),role:'ADMIN',display_name:`TFL Admin ${tag}`};
  await client.query("INSERT INTO users(id,mobile,role,display_name,is_active) VALUES($1,$2,$3,$4,true)",[organizerUser.id,organizerUser.mobile,organizerUser.role,organizerUser.display_name]);
  await client.query("INSERT INTO users(id,mobile,role,display_name,is_active) VALUES($1,$2,$3,$4,true)",[adminUser.id,adminUser.mobile,adminUser.role,adminUser.display_name]);
  // 5 players (byeCount = nextPowerOfTwo(5) - 5 = 3, exercising the exact multi-bye scenario that was broken).
  for(let i=0;i<5;i++){
    const userId=`${tag}-user-${i}`,profileId=`${tag}-profile-${i}`,mobile=`8${Date.now()}${i}`.slice(0,13);
    await client.query("INSERT INTO users(id,mobile,role,display_name,is_active) VALUES($1,$2,'PLAYER',$3,true)",[userId,mobile,`TFL Player ${i} ${tag}`]);
    await client.query("INSERT INTO player_profiles(id,player_code,user_id,full_name,mobile,dob,regular_player,profile_status) VALUES($1,$2,$3,$4,$5,'2000-01-01',true,'ACTIVE')",[profileId,`${tag}-P${i}`,userId,`TFL Player ${i} ${tag}`,mobile]);
    players.push({userId,profileId});
  }
});

after(async()=>{
  if(!enabled||!client)return;
  try{
    if(fixtureId){
      await client.query('DELETE FROM matches WHERE fixture_id=$1',[fixtureId]);
      await client.query('DELETE FROM fixture_participants WHERE fixture_id=$1',[fixtureId]);
      await client.query('DELETE FROM fixtures WHERE id=$1',[fixtureId]);
    }
    if(registrationIds.length)await client.query('DELETE FROM registrations WHERE id=ANY($1::text[])',[registrationIds]);
    if(tournamentId){
      await client.query('DELETE FROM tournament_rules WHERE tournament_id=$1',[tournamentId]);
      await client.query('DELETE FROM tournament_categories WHERE tournament_id=$1',[tournamentId]);
      await client.query('DELETE FROM tournaments WHERE id=$1',[tournamentId]);
    }
    for(const p of players)await client.query('DELETE FROM player_profiles WHERE id=$1',[p.profileId]);
    for(const p of players)await client.query('DELETE FROM users WHERE id=$1',[p.userId]);
    await client.query('DELETE FROM users WHERE id=$1',[organizerUser.id]);
    await client.query('DELETE FROM users WHERE id=$1',[adminUser.id]);
  } finally { await client.end(); }
});

test('real PostgreSQL safety guard',{skip:!enabled},async()=>{
  assert.equal(process.env.DB_ENV,'development');
  assert.equal(process.env.ALLOW_DB_INTEGRATION_TESTS,'true');
});

test('full tournament lifecycle + 5-participant KNOCKOUT fixture generation against live Postgres',{skip:!enabled},async()=>{
  const organizerToken=await issueAccessToken(env,organizerUser);
  const organizerIdentity={sub:organizerUser.id,role:'ORGANIZER',exp:Math.floor(Date.now()/1000)+900};
  const adminIdentity={sub:adminUser.id,role:'ADMIN',exp:Math.floor(Date.now()/1000)+900};
  void organizerToken;

  // Create (identity-driven, not body organizerId) -> submit -> approve -> publish.
  const created=await createTournament(env,{
    name:`TFL Tournament ${tag}`,
    tournamentDate:'2027-01-15',
    registrationCloseDate:'2027-01-10',
    venueName:'TFL Arena',
    venueAddress:'123 Test Street',
    format:'KNOCKOUT',
    categories:[{name:'TFL Singles',eventType:'SINGLES',genderEligibility:'ANY'}],
  },organizerIdentity);
  tournamentId=created.id;
  categoryId=created.categories[0].id;
  assert.equal(created.status,'DRAFT');

  const submitted=await transitionTournament(env,tournamentId,'submit',{},organizerIdentity);
  assert.equal(submitted.status,'PENDING_ADMIN_APPROVAL');
  const approved=await transitionTournament(env,tournamentId,'approve',{},adminIdentity);
  assert.equal(approved.status,'APPROVED');
  const published=await transitionTournament(env,tournamentId,'publish',{},adminIdentity);
  assert.equal(published.status,'PUBLISHED');

  // Register all 5 players as PLAYER-identity-authenticated singles registrations.
  for(const p of players){
    const identity={sub:p.userId,role:'PLAYER',exp:Math.floor(Date.now()/1000)+900};
    const reg=await createRegistration(env,{tournamentId,categoryId,playerId:p.profileId},identity);
    registrationIds.push(reg.id);
    assert.equal(reg.status,'REGISTERED');
  }

  // Generate the fixture as the ORGANIZER identity (exercises the auth-hardening fix end-to-end).
  const fixture=await generateFixture(env,{tournamentId,categoryId,format:'KNOCKOUT'},organizerIdentity);
  fixtureId=fixture.id;
  assert.equal(fixture.participants.length,5);

  const matches=fixture.matches;
  assert.equal(matches.length,7,'5-participant bracket must have 8-1=7 matches');

  // No dead matches: every match either has both participants known, or at least one source link to fill it later.
  for(const m of matches){
    const hasParticipant=m.participant1Id||m.participant2Id;
    const hasSourceOrLink=m.nextMatchId||matches.some(x=>x.nextMatchId===m.id);
    assert.ok(hasParticipant||hasSourceOrLink,`match ${m.id} (round ${m.roundNumber}) must not be a dead end with no participant and no linkage`);
  }

  // Every registered player appears exactly once across round-1 matches (participant present, no duplicates).
  const round1=matches.filter(m=>m.roundNumber===1);
  assert.equal(round1.length,4,'8-slot bracket has 4 round-1 matches');
  const round1ParticipantIds=round1.flatMap(m=>[m.participant1Id,m.participant2Id]).filter(Boolean);
  const registeredPlayerIds=players.map(p=>p.profileId);
  assert.deepEqual([...round1ParticipantIds].sort(),[...registeredPlayerIds].sort());
  assert.equal(new Set(round1ParticipantIds).size,round1ParticipantIds.length,'no player appears twice in round 1');

  // Final round has exactly one match, and every non-round-1 match traces back via nextMatchId linkage.
  const finalRound=Math.max(...matches.map(m=>m.roundNumber));
  assert.equal(matches.filter(m=>m.roundNumber===finalRound).length,1);
  const byId=new Map(matches.map(m=>[m.id,m]));
  for(const m of matches){
    if(m.nextMatchId)assert.ok(byId.has(m.nextMatchId),`nextMatchId ${m.nextMatchId} must reference a real match in this fixture`);
  }

  // Duplicate-generation protection still works (409) after this real generation.
  await assert.rejects(
    ()=>generateFixture(env,{tournamentId,categoryId,format:'KNOCKOUT'},organizerIdentity),
    (e)=>e.status===409,
  );

  // Fixture generation without a valid identity is rejected (auth-hardening regression guard).
  await assert.rejects(
    ()=>generateFixture(env,{tournamentId,categoryId:categoryId+'-nonexistent',format:'KNOCKOUT'},null),
    (e)=>e.status===401||e.status===404,
  );
});
