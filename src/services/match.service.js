import {generateInTransaction} from './result.service.js';
import {withDatabase,withTransaction} from '../db/database.js';import * as repo from '../repositories/match.repository.js';import {mapMatchRow,mapHistoryRow} from '../mappers/match.mapper.js';
export class MatchError extends Error{constructor(message,status=400){super(message);this.status=status;}}
async function auth(db,input,m,identity){if(!identity)throw new MatchError('Authentication required',401);const u=(await db.query('SELECT * FROM users WHERE id=$1',[identity.sub])).rows[0];if(!u||!u.is_active||!['ORGANIZER','ADMIN'].includes(u.role))throw new MatchError('Organizer or ADMIN authorization required',403);if(u.role==='ORGANIZER'){const t=(await db.query('SELECT organizer_id FROM tournaments WHERE id=$1',[m.tournament_id])).rows[0];if(!t||t.organizer_id!==u.id)throw new MatchError('Organizer does not own this tournament',403);}}
const validPoints = value => [15,21,30].includes(value);
const validateScores = (a,b,limit) => {
  if (!validPoints(limit)) throw new MatchError('Valid winningPoints are required');
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) throw new MatchError('Score cannot go below zero');
  if (a > limit || b > limit) throw new MatchError('Score limit reached');
};
async function enriched(db,row){const out=mapMatchRow(row);if(row.winner_id){const type=row.winner_id===row.participant1_id?row.participant1_type:row.participant2_type;const d=await repo.participantDisplay(db,row.winner_id,type);out.winnerParticipantId=row.winner_id;out.winnerParticipantType=type;out.winnerParticipantName=d?.name??null;out.winnerParticipantCode=d?.code??null;}return out;}
export const list=(env,q)=>withDatabase(env,async db=>(await repo.all(db,q)).map(mapMatchRow));
export const get=(env,id)=>withDatabase(env,async db=>{const m=await repo.byId(db,id);if(!m)throw new MatchError('Match not found',404);return enriched(db,m);});
export const hist=(env,id)=>withDatabase(env,async db=>(await repo.history(db,id)).map(mapHistoryRow));
export const start=(env,id,input,identity)=>withTransaction(env,async db=>{const m=await repo.byId(db,id,true);if(!m)throw new MatchError('Match not found',404);await auth(db,input,m,identity);const f=await repo.fixture(db,m.fixture_id);if(!f||f.status!=='PUBLISHED')throw new MatchError('Fixture must be PUBLISHED',409);if(m.status!=='SCHEDULED')throw new MatchError('Match must be SCHEDULED');if(!m.participant1_id||!m.participant2_id)throw new MatchError('Match participants are incomplete');const points=input.winningPoints??m.winning_points;if(!validPoints(points))throw new MatchError('Select winningPoints: 15, 21 or 30');validateScores(m.participant1_score??0,m.participant2_score??0,points);return mapMatchRow(await repo.updateStart(db,id,points));});
export const score=(env,id,input,identity)=>withTransaction(env,async db=>{const m=await repo.byId(db,id,true);if(!m)throw new MatchError('Match not found',404);await auth(db,input,m,identity);if(m.status==='COMPLETED')throw new MatchError('Match is already completed',409);if(m.status!=='LIVE')throw new MatchError('Match must be LIVE');if(!['A','B'].includes(input.side))throw new MatchError('Invalid score side');if(!['INCREMENT','DECREMENT'].includes(input.action??'INCREMENT'))throw new MatchError('Invalid score action');let a=m.participant1_score??0,b=m.participant2_score??0;const d=input.action==='DECREMENT'?-1:1;if(input.side==='A')a+=d;else b+=d;validateScores(a,b,m.winning_points);const saved=await repo.updateScore(db,id,a,b,'LIVE',null);await repo.addHistory(db,id,a,b,input.action??'INCREMENT',identity.sub);return enriched(db,saved);});
export const complete=(env,id,input,identity)=>withTransaction(env,async db=>{const m=await repo.byId(db,id,true);if(!m)throw new MatchError('Match not found',404);await auth(db,input,m,identity);if(m.status==='COMPLETED'){if(await repo.isFinalMatch(db,m))await generateInTransaction(db,{requestedByUserId:identity.sub,tournamentId:m.tournament_id,categoryId:m.category_id});return enriched(db,m);}if(m.status!=='LIVE')throw new MatchError('Match must be LIVE');
const a=m.participant1_score??0,b=m.participant2_score??0;
validateScores(a,b,m.winning_points);
if(a===b)throw new MatchError('Scores must not be tied');
if(!m.participant1_id||!m.participant2_id)throw new MatchError('Match participants are incomplete');
const saved=await repo.updateScore(db,id,a,b,'COMPLETED',a>b?m.participant1_id:m.participant2_id);
// Results and medals are awarded only after the terminal knockout match.
const fixture=await repo.fixture(db,m.fixture_id);
if(fixture?.format==='KNOCKOUT' && await repo.isFinalMatch(db,m)) {
  await generateInTransaction(db,{requestedByUserId:identity.sub,tournamentId:m.tournament_id,categoryId:m.category_id});
}
return enriched(db,saved);});
