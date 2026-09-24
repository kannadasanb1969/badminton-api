import { withDatabase, withTransaction } from '../db/database.js';
import * as repo from '../repositories/fixture.repository.js';
import { mapFixtureRow, mapTeamRow } from '../mappers/fixture.mapper.js';
import { buildKnockoutBracket, buildRoundRobinSchedule, calculatePoolSizes, assignPools, selectQualifiers } from '../utils/friendly-fixtures.js';
export class FixtureError extends Error { constructor(message,status=400){super(message);this.status=status;} }
const shuffle = (a) => { const x=[...a]; for(let i=x.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[x[i],x[j]]=[x[j],x[i]];} return x; };
// Resolves the acting user from the VERIFIED bearer token identity (not client-supplied organizerUserId/requestedByUserId body fields).
async function actor(db,identity,row){if(!identity)throw new FixtureError('Authentication required',401);const u=await repo.users(db,identity.sub);if(!u||!u.is_active||!['ORGANIZER','ADMIN'].includes(u.role))throw new FixtureError('Organizer or ADMIN authorization required',403);if(u.role==='ORGANIZER'&&u.id!==row.organizer_id)throw new FixtureError('Organizer does not own this tournament',403);return u;}
async function ensureTeams(db,regs,t,c){
  // Real display name/code for SINGLES participants (was previously the raw player_id UUID —
  // see fixture_participants.display_name — leaving mobile/organizer bracket views showing "TBD").
  const singlesIds=regs.filter(r=>r.event_type==='SINGLES').map(r=>r.player_id);
  const profiles=await repo.playerProfilesByIds(db,singlesIds);
  const out=[];for(const r of regs){if(r.event_type==='SINGLES'){const p=profiles.get(r.player_id);out.push({id:r.player_id,type:'PLAYER',name:p?.full_name??r.player_id,code:p?.player_code??r.player_id});continue;}let ts=await repo.teams(db,t,c);let team=ts.find(x=>x.player1_id===r.player_id&&x.player2_id===r.partner_id);if(!team)team=await repo.insertTeam(db,t,c,r.player_id,'FULL',r.partner_id,r.partner_type==='GUEST'?'GUEST':'FULL',await repo.nextCode(db,'TEM','teams','team_code').then(n=>'TEM'+(BigInt(n)+1n).toString().padStart(6,'0')));out.push({id:team.id,type:'TEAM',name:team.team_code,code:team.team_code,team});}return out;}
const camel=(row)=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k.replace(/_([a-z])/g,(_,c)=>c.toUpperCase()),v]));
// Pool/qualification data lives in side-tables the app DB role owns (see fixture.repository.js), not as
// columns on fixture_participants/matches/fixtures — so poolId and the qualification config are joined onto
// the mapped fixture payload here in JS instead of coming back from a single SQL row.
async function mapped(db,f){
  const [participantRows,matchRows,pools,participantLinks,matchLinks,qualification]=await Promise.all([
    repo.fixtureParticipants(db,f.id),repo.fixtureMatches(db,f.id),repo.fixturePools(db,f.id),
    repo.poolParticipantLinks(db,f.id),repo.poolMatchLinks(db,f.id),repo.qualificationConfig(db,f.id),
  ]);
  const poolByParticipant=new Map(participantLinks.map(l=>[String(l.participant_id),l.pool_id]));
  const poolByMatch=new Map(matchLinks.map(l=>[String(l.match_id),l.pool_id]));
  const participants=participantRows.map(x=>({...camel(x),poolId:poolByParticipant.get(String(x.participant_id))??null}));
  const matches=matchRows.map(x=>({...camel(x),poolId:poolByMatch.get(String(x.id))??null}));
  const out=mapFixtureRow(f,participants,matches,pools);
  return {...out,qualifiersPerPool:qualification?.qualifiers_per_pool??null,wildcardCount:qualification?.wildcard_count??0,bestThirdPlaceCount:qualification?.best_third_place_count??0,targetKnockoutBracketSize:qualification?.target_knockout_bracket_size??null,promotedToFixtureId:qualification?.promoted_to_fixture_id??null};
}
export const listFixtures=(env,filters)=>withDatabase(env,async db=>Promise.all((await repo.listFixtures(db,filters)).map(f=>mapped(db,f))));
export const getFixture=(env,id)=>withDatabase(env,async db=>{const f=await repo.findFixture(db,id);if(!f)throw new FixtureError('Fixture not found',404);return mapped(db,f);});
export async function publish(env,id,identity){return withTransaction(env,async db=>{const f=await repo.findFixture(db,id);if(!f)throw new FixtureError('Fixture not found',404);if(!identity)throw new FixtureError('Authentication required',401);const u=await repo.users(db,identity.sub);if(!u||!u.is_active||!['ORGANIZER','ADMIN'].includes(u.role))throw new FixtureError('Organizer or ADMIN authorization required',403);const t=await repo.tournament(db,f.tournament_id);if(u.role==='ORGANIZER'&&u.id!==t.organizer_id)throw new FixtureError('Organizer does not own this tournament',403);if(f.status!=='DRAFT')throw new FixtureError('Fixture is already published',409);return mapped(db,await repo.publishFixture(db,id,u.id));});}
// No pool/PF/PA/points ranking rule exists anywhere else in the codebase (Friendly Match standings only
// track Played/Won/Lost and explicitly flag ties as TIE_BREAK_REQUIRED rather than resolving them) — this is
// new logic, not a reuse of an existing rule: 2 points per win, ranked by points, then point-difference, then
// points-for, all computed from the same participant1/2_score + winner_id columns matches already persist.
function computePoolStandings(participants,matches){
  const rows=new Map(participants.map(p=>[String(p.participantId),{participantId:String(p.participantId),displayName:p.displayName,played:0,won:0,lost:0,pointsFor:0,pointsAgainst:0,pointDiff:0,points:0}]));
  for(const m of matches){
    if(String(m.status).toUpperCase()!=='COMPLETED')continue;
    const p1=String(m.participant1Id??''),p2=String(m.participant2Id??''),winner=String(m.winnerId??'');
    const s1=Number(m.participant1Score??0),s2=Number(m.participant2Score??0);
    const r1=rows.get(p1),r2=rows.get(p2);if(!r1||!r2)continue;
    r1.played++;r2.played++;r1.pointsFor+=s1;r1.pointsAgainst+=s2;r2.pointsFor+=s2;r2.pointsAgainst+=s1;
    if(winner===p1){r1.won++;r1.points+=2;r2.lost++;}else if(winner===p2){r2.won++;r2.points+=2;r1.lost++;}
  }
  const out=[...rows.values()];for(const r of out)r.pointDiff=r.pointsFor-r.pointsAgainst;
  return out.sort((a,b)=>b.points-a.points||b.pointDiff-a.pointDiff||b.pointsFor-a.pointsFor);
}
export const getStandings=(env,id)=>withDatabase(env,async db=>{
  const f=await repo.findFixture(db,id);if(!f)throw new FixtureError('Fixture not found',404);
  const full=await mapped(db,f);
  return {fixtureId:id,format:full.format,pools:full.pools.map(pool=>({...pool,standings:computePoolStandings(full.participants.filter(p=>String(p.poolId)===String(pool.id)),full.matches.filter(m=>String(m.poolId)===String(pool.id)))}))};
});
// League -> Knockout bridge (Phase 7): did not exist before (no fixture ever chained into another). A
// promoted category's `fixtures` row has a UNIQUE(category_id) constraint (confirmed live), so a second
// fixture for the same category is impossible — promotion instead appends the knockout bracket's matches
// onto the SAME fixture, round-numbered to continue after the pool rounds, and simply never links them into
// fixture_pool_matches (poolId stays null for them, which is how the League/Bracket views tell pool matches
// from bracket matches apart). Qualifiers are already this fixture's participants from pool generation, so no
// new fixture_participants rows are inserted either — only the qualifiers' knockout topology is new. Bracket
// construction itself reuses buildKnockoutBracket/linkNextMatch exactly as Knockout generation already does.
// Idempotent: a fixture already promoted just returns its current state instead of promoting again.
export async function promote(env,fixtureId,identity){return withTransaction(env,async db=>{
  const f=await repo.findFixture(db,fixtureId);if(!f)throw new FixtureError('Fixture not found',404);
  const t=await repo.tournament(db,f.tournament_id);await actor(db,identity,t);
  if(f.format!=='LEAGUE'&&f.format!=='ROUND_ROBIN')throw new FixtureError('Only League fixtures can be promoted to a Knockout stage',409);
  const config=await repo.qualificationConfig(db,f.id);
  if(config?.promoted_to_fixture_id)return mapped(db,f);
  const full=await mapped(db,f);
  if(!full.pools.length)throw new FixtureError('Fixture has no pools to qualify from',409);
  if(full.matches.some(m=>String(m.status).toUpperCase()!=='COMPLETED'))throw new FixtureError('All pool matches must be completed before promoting qualifiers',409);
  const poolStandings=full.pools.map(pool=>({poolId:pool.id,standings:computePoolStandings(full.participants.filter(p=>String(p.poolId)===String(pool.id)),full.matches.filter(m=>String(m.poolId)===String(pool.id)))}));
  const qualifiers=selectQualifiers(poolStandings,{qualifiersPerPool:config?.qualifiers_per_pool??1,bestThirdPlaceCount:config?.best_third_place_count??0,wildcardCount:config?.wildcard_count??0,targetBracketSize:config?.target_knockout_bracket_size??null});
  if(qualifiers.length<2)throw new FixtureError('At least two qualifiers are required to build a knockout bracket',409);
  const parts=qualifiers.map(q=>{const p=full.participants.find(x=>String(x.participantId)===String(q.participantId));return {id:p.participantId,type:p.participantType,name:p.displayName,code:p.displayCode};});
  const roundOffset=Math.max(0,...full.matches.map(m=>Number(m.roundNumber)||0));
  const topology=buildKnockoutBracket(parts);const ids=new Map();let n=full.matches.length+1;
  for(const x of topology.matches){const row=await repo.insertMatch(db,f.id,f.tournament_id,f.category_id,n++,x.participant1?.id??null,x.participant1?.type??null,x.participant2?.id??null,x.participant2?.type??null,roundOffset+x.round);ids.set(x.key,row.id);}
  for(const x of topology.matches){if(x.next)await repo.linkNextMatch(db,ids.get(x.key),ids.get(x.next),x.nextSlot);}
  await repo.markPromoted(db,f.id,f.id);
  return mapped(db,f);
});}
export const listTeams=(env,filters)=>withDatabase(env,async db=>Promise.all((await repo.teams(db,filters.tournamentId,filters.categoryId)).map(r=>mapTeamRow(r))));
export const getTeam=(env,id)=>withDatabase(env,async db=>{const row=await repo.teamById(db,id);if(!row)throw new FixtureError('Team not found',404);return mapTeamRow(row);});
// The one authoritative pool-generation routine (Step 5 requirement: no second pool algorithm). Used both for
// a brand-new League/ROUND_ROBIN fixture and to rebuild a legacy one (see generate() below) — the only
// difference is whether fixture_participants rows need inserting or already exist.
async function generatePools(db,f,t,c,parts,input,{insertParticipants}){
  await repo.insertQualificationConfig(db,f.id,{qualifiersPerPool:input.qualifiersPerPool??1,wildcardCount:input.wildcardCount??0,bestThirdPlaceCount:input.bestThirdPlaceCount??0,targetKnockoutBracketSize:input.targetKnockoutBracketSize??null});
  // Dynamic pool split: calculatePoolSizes picks a generic pool-count/size solution (MIN 3 / TARGET 4 / MAX 6,
  // balanced, deterministic — see friendly-fixtures.js) instead of always treating the whole field as one
  // league group. Each pool then gets its own independent circle-method round-robin schedule (round numbers
  // restart at 1 per pool, matches linked to their pool via fixture_pool_matches) so pools never bleed into
  // each other's rounds/results.
  const poolSizes=calculatePoolSizes(parts.length);const pools=assignPools(parts,poolSizes);let seed=1,n=1;
  for(let pi=0;pi<pools.length;pi++){
    const pool=pools[pi];const poolRow=await repo.insertPool(db,f.id,t.id,c.id,pool.name,pi+1);
    for(const p of pool.participants){if(insertParticipants)await repo.insertParticipant(db,f.id,p.id,p.type,seed,p.name,p.code);await repo.linkParticipantToPool(db,poolRow.id,f.id,p.id,p.type,seed);seed++;}
    const rrSchedule=buildRoundRobinSchedule(pool.participants);
    for(let r=0;r<rrSchedule.length;r++)for(const x of rrSchedule[r]){const row=await repo.insertMatch(db,f.id,t.id,c.id,n++,x.participant1.id,x.participant1.type,x.participant2.id,x.participant2.type,r+1);await repo.linkMatchToPool(db,poolRow.id,f.id,row.id);}
  }
}
export async function generate(env,input,identity){if(!input?.tournamentId||!input?.categoryId)throw new FixtureError('tournamentId and categoryId are required');return withTransaction(env,async db=>{const t=await repo.tournament(db,input.tournamentId);const c=await repo.category(db,input.categoryId);if(!t||!c)throw new FixtureError('Tournament or category not found',404);if(c.tournament_id!==t.id)throw new FixtureError('Category does not belong to tournament');if(t.status!=='PUBLISHED')throw new FixtureError('Tournament must be PUBLISHED');const u=await actor(db,identity,t);
  const existing=await repo.existingFixture(db,t.id,c.id);
  if(existing){
    const existingIsPooled=existing.format==='LEAGUE'||existing.format==='ROUND_ROBIN';
    const existingPools=existingIsPooled?await repo.fixturePools(db,existing.id):[];
    if(existingIsPooled&&existingPools.length===0){
      // Legacy fixture generated before the pool engine existed: zero fixture_pools rows. Only safe to rebuild
      // in place (same fixture id/code, no duplicate fixture, no data invented) when nothing has actually been
      // played yet — otherwise fail loudly instead of silently discarding real results.
      const existingMatches=await repo.fixtureMatches(db,existing.id);
      if(existingMatches.some(m=>['COMPLETED','LIVE'].includes(String(m.status).toUpperCase())))throw new FixtureError('Existing League fixture already has matches in progress and cannot be automatically converted into pools',409);
      const existingParticipantRows=await repo.fixtureParticipants(db,existing.id);
      const parts=existingParticipantRows.map(p=>({id:p.participant_id,type:p.participant_type,name:p.display_name,code:p.display_code}));
      await repo.deleteFixtureMatches(db,existing.id);
      await repo.deleteFixturePools(db,existing.id);
      await generatePools(db,existing,t,c,parts,input,{insertParticipants:false});
      return mapped(db,existing);
    }
    throw new FixtureError('Fixture already generated for this category',409);
  }
  const regs=await repo.registrations(db,t.id,c.id);if(regs.length<2)throw new FixtureError('At least two active registrations are required');const parts=shuffle(await ensureTeams(db,regs,t.id,c.id));const format=input.format??t.format;if(!['KNOCKOUT','LEAGUE','ROUND_ROBIN'].includes(format))throw new FixtureError('Fixture format is not supported');const isPooled=format==='LEAGUE'||format==='ROUND_ROBIN';const f=await repo.insertFixture(db,t.id,c.id,format,c.event_type,u.id,'FIX'+(BigInt(await repo.nextCode(db,'FIX','fixtures','fixture_code'))+1n).toString().padStart(6,'0'));if(isPooled){
  await generatePools(db,f,t,c,parts,input,{insertParticipants:true});
}else{
  for(let i=0;i<parts.length;i++){const p=parts[i];await repo.insertParticipant(db,f.id,p.id,p.type,i+1,p.name,p.code);}
  // Full BYE-aware bracket (any participant count, not just powers of two): bracket size rounds up to the next
  // power of two, byes are seeded so a bye-winner's participant is carried straight into their round-2+ slot
  // (see buildKnockoutBracket), matching the same algorithm already used for friendly-match knockout fixtures.
  const topology=buildKnockoutBracket(parts);const ids=new Map();let n=1;
  for(const x of topology.matches){const autoAdvanced=Boolean(x.byeParticipant);const status=autoAdvanced?'WALKOVER':'SCHEDULED';const row=await repo.insertMatch(db,f.id,t.id,c.id,n++,x.participant1?.id??null,x.participant1?.type??null,x.participant2?.id??null,x.participant2?.type??null,x.round,status,autoAdvanced);ids.set(x.key,row.id);}
  for(const x of topology.matches){if(x.next)await repo.linkNextMatch(db,ids.get(x.key),ids.get(x.next),x.nextSlot);}
}return mapped(db,f);});}
