import {completedResultSummaries,withCompletion} from '../repositories/completion.repository.js';
import {withDatabase,withTransaction} from '../db/database.js';
import * as repo from '../repositories/tournament.repository.js';
import {findById as findUser} from '../repositories/user.repository.js';
import {mapTournament} from '../mappers/tournament.mapper.js';
import {emit} from './notification.events.js';
export class TournamentError extends Error {
  constructor(message,status=400){super(message);this.status=status;}
}
const fields={name:'name',description:'description',tournamentDate:'tournament_date',reportingTime:'reporting_time',registrationCloseDate:'registration_close_date',registrationCloseTime:'registration_close_time',venueName:'venue_name',venueAddress:'venue_address',mapLink:'map_link',format:'format',prizes:'prizes',shuttle:'shuttle',scoringFormat:'scoring_format',registrationFee:'registration_fee',prizeType:'prize_type',winnerTrophyName:'winner_trophy_name',runnerUpTrophyName:'runner_up_trophy_name',thirdPlaceTrophyName:'third_place_trophy_name',winnerCashAmount:'winner_cash_amount',runnerUpCashAmount:'runner_up_cash_amount',thirdPlaceCashAmount:'third_place_cash_amount',thirdPlaceEnabled:'third_place_enabled'};
const aliases={startDate:'tournamentDate',registrationEndDate:'registrationCloseDate',venue:'venueName',location:'venueAddress',fixtureFormat:'format',entryFee:'registrationFee'};
// Money columns are `numeric` in Postgres, not strings — validated/coerced separately from the
// generic string-or-null loop below. Kept in `fields` so insert()/update() still write them.
const MONEY_FIELDS=['registration_fee','winner_cash_amount','runner_up_cash_amount','third_place_cash_amount'];
const PRIZE_TYPES=['NONE','TROPHY','CASH','BOTH'];
function object(value){if(!value || typeof value!=='object' || Array.isArray(value))throw new TournamentError('JSON object required');}
function text(value,label){if(typeof value!=='string'||!value.trim())throw new TournamentError(`${label} is required`);return value.trim();}
function date(value,label){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new TournamentError(`${label} must be YYYY-MM-DD`);
  const d=new Date(value+'T00:00:00Z');if(Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==value)throw new TournamentError(`Invalid ${label}`);return value;
}
function validate(input,existing={}){
  object(input);const source={...input};
  // Compatibility-only endDate and registrationStartDate are ignored and returned as null — no
  // migrated column backs them. entryFee is accepted as a legacy alias for registrationFee (see
  // `aliases` above) and IS persisted.
  for(const key of ['status','approvedBy','approvedAt','publishedAt','submittedAt','rejectedAt','rejectedBy','rejectionReason','id','tournamentCode'])if(Object.hasOwn(source,key))throw new TournamentError(`${key} cannot be set through profile edits`);
  for(const [alias,target] of Object.entries(aliases))if(Object.hasOwn(source,alias)){
    source[target]=source[alias];
  }
  const result=Object.fromEntries(Object.values(fields).map(k=>[k,existing[k]??null]));result.format??='KNOCKOUT';result.prize_type??='NONE';
  for(const [key,column] of Object.entries(fields))if(Object.hasOwn(source,key))result[column]=source[key];
  result.name=text(result.name,'name');
  for(const [key,column] of Object.entries(fields)){
    if(MONEY_FIELDS.includes(column)||column==='third_place_enabled')continue;
    if(result[column]!==null&&typeof result[column]!=='string'&&!(result[column] instanceof Date))throw new TournamentError(`${key} must be a string or null`);
  }
  if(result.tournament_date instanceof Date)result.tournament_date=result.tournament_date.toISOString().slice(0,10);
  if(result.registration_close_date instanceof Date)result.registration_close_date=result.registration_close_date.toISOString().slice(0,10);
  date(result.tournament_date,'tournamentDate');
  if(result.registration_close_date!==null){date(result.registration_close_date,'registrationCloseDate');if(result.registration_close_date>result.tournament_date)throw new TournamentError('registrationCloseDate must not be after tournamentDate');}
  for(const key of ['reporting_time','registration_close_time'])if(result[key]!==null&&!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(result[key]))throw new TournamentError('Invalid time');
  if(!['KNOCKOUT','LEAGUE','ROUND_ROBIN','GROUP_KNOCKOUT'].includes(result.format))throw new TournamentError('Invalid fixture format');
  // Registration fee: 0 = free, must always end up a non-negative number (the column is NOT NULL).
  result.registration_fee=result.registration_fee===null||result.registration_fee===''?0:result.registration_fee;
  for(const column of MONEY_FIELDS){
    if(column==='registration_fee'&&result[column]===0)continue;
    if(result[column]===null||result[column]==='')continue;
    const n=typeof result[column]==='string'?Number(result[column]):result[column];
    if(typeof n!=='number'||!Number.isFinite(n)||n<0)throw new TournamentError(`${column} must be a non-negative number`);
    result[column]=Math.round(n*100)/100;
  }
  if(!PRIZE_TYPES.includes(result.prize_type))throw new TournamentError('prizeType must be one of NONE, TROPHY, CASH, BOTH');
  if(result.third_place_enabled===null)result.third_place_enabled=false;
  if(typeof result.third_place_enabled!=='boolean')throw new TournamentError('thirdPlaceEnabled must be a boolean');
  // Prize fields are normalized (nulled) for any category the organizer's selections don't apply
  // to, so a form's leftover/hidden values from a previous prizeType or a disabled 3rd-place
  // toggle can never persist as stale data.
  if(!['TROPHY','BOTH'].includes(result.prize_type)){result.winner_trophy_name=null;result.runner_up_trophy_name=null;result.third_place_trophy_name=null;}
  if(!['CASH','BOTH'].includes(result.prize_type)){result.winner_cash_amount=null;result.runner_up_cash_amount=null;result.third_place_cash_amount=null;}
  if(!result.third_place_enabled){result.third_place_trophy_name=null;result.third_place_cash_amount=null;}
  return result;
}
function category(input,existing={}){
  object(input);const result={...existing};
  const mapping={name:'name',eventType:'event_type',genderEligibility:'gender_eligibility',gender:'gender_eligibility',minAge:'min_age',maxAge:'max_age',maxTeams:'max_teams',medalistsAllowed:'medalists_allowed',openPlayersAllowed:'open_players_allowed',beginnerOnly:'beginner_only',pureBeginnerOnly:'pure_beginner_only',additionalRuleNotes:'additional_rule_notes'};
  const defaults={gender_eligibility:'ANY',min_age:null,max_age:null,max_teams:null,medalists_allowed:true,open_players_allowed:true,beginner_only:false,pure_beginner_only:false,additional_rule_notes:null};
  for(const [k,v] of Object.entries(defaults))if(result[k]===undefined)result[k]=v;
  for(const [key,col] of Object.entries(mapping))if(Object.hasOwn(input,key))result[col]=input[key];
  result.name=text(result.name,'category name');if(!['SINGLES','DOUBLES'].includes(result.event_type))throw new TournamentError('eventType must be SINGLES or DOUBLES');
  if(!['MALE','FEMALE','ANY','MIXED'].includes(result.gender_eligibility))throw new TournamentError('Invalid gender eligibility');
  for(const key of ['min_age','max_age','max_teams'])if(result[key]!==null&&(!Number.isInteger(result[key])||result[key]<(key==='max_teams'?1:0)||result[key]>2147483647))throw new TournamentError(`Invalid ${key}`);
  if(result.min_age!==null&&result.max_age!==null&&result.min_age>result.max_age)throw new TournamentError('Invalid age range');
  for(const key of ['medalists_allowed','open_players_allowed','beginner_only','pure_beginner_only'])if(typeof result[key]!=='boolean')throw new TournamentError(`Invalid ${key}`);
  if(result.additional_rule_notes!==null&&typeof result.additional_rule_notes!=='string')throw new TournamentError('Invalid rule notes');return result;
}
async function nested(db,id,input){
  if(Object.hasOwn(input,'categories')){
    if(!Array.isArray(input.categories))throw new TournamentError('categories must be an array');
    const old=await repo.categories(db,id);const seen=new Set();
    for(const item of input.categories){object(item);let prior;
      if(item.id){prior=old.find(c=>c.id===item.id);if(!prior||seen.has(item.id))throw new TournamentError('Invalid or repeated category ID');seen.add(item.id);}
      await repo.saveCategory(db,id,category(item,prior));
    }
    // Existing categories omitted from PUT are retained with stable IDs.
  }
  if(Object.hasOwn(input,'generalRules')){
    if(!Array.isArray(input.generalRules))throw new TournamentError('generalRules must be an array');
    await repo.replaceRules(db,id,input.generalRules.map(r=>text(r,'rule')));
  }
}
async function mapped(db,row){if(!row)throw new TournamentError('Tournament not found',404);const counts=await repo.registrationCounts(db,[row.id]);const cs=await repo.categories(db,row.id);const categories=cs.map(c=>{const x=counts.categories.get(c.id);return {...c,registeredPlayerCount:x?.registered_player_count??0,registeredEntryCount:x?.registered_entry_count??0,registeredTeamCount:x?.registered_team_count??0};});const t=counts.tournaments.get(row.id);const value={...mapTournament(row,categories,await repo.rules(db,row.id)),registeredPlayerCount:t?.registered_player_count??0,registeredEntryCount:t?.registered_entry_count??0,registeredTeamCount:t?.registered_team_count??0};return withCompletion(value,await completedResultSummaries(db,[row.id]));}
async function actor(db,id){const user=typeof id==='string'?await findUser(db,id):null;if(!user||!user.is_active)throw new TournamentError('Authorization required',403);return user;}
// Resolves the acting user from the VERIFIED bearer token identity (not a client-supplied body field).
async function identityActor(db,identity){if(!identity)throw new TournamentError('Authentication required',401);return actor(db,identity.sub);}
async function owner(db,row,identity){const user=await identityActor(db,identity);if(user.role!=='ADMIN'&&(user.role!=='ORGANIZER'||user.id!==row.organizer_id))throw new TournamentError('Not authorized for this tournament',403);return user;}
export const listTournaments=(env,filters={})=>withDatabase(env,async db=>{
  const rows=await repo.findAll(db,filters);if(!rows.length)return [];
  const ids=rows.map(row=>row.id);
  const counts=await repo.registrationCounts(db,ids);
  const categories=(await db.query('SELECT * FROM tournament_categories WHERE tournament_id=ANY($1::text[]) ORDER BY created_at,id',[ids])).rows;
  const rules=(await db.query('SELECT * FROM tournament_rules WHERE tournament_id=ANY($1::text[]) ORDER BY sort_order,id',[ids])).rows;
  const summaries=await completedResultSummaries(db,ids);
  return rows.map(row=>{
    const cs=categories.filter(category=>category.tournament_id===row.id).map(category=>{const count=counts.categories.get(category.id);return {...category,registeredPlayerCount:count?.registered_player_count??0,registeredEntryCount:count?.registered_entry_count??0,registeredTeamCount:count?.registered_team_count??0};});
    const count=counts.tournaments.get(row.id);
    return withCompletion({...mapTournament(row,cs,rules.filter(rule=>rule.tournament_id===row.id)),registeredPlayerCount:count?.registered_player_count??0,registeredEntryCount:count?.registered_entry_count??0,registeredTeamCount:count?.registered_team_count??0},summaries);
  });
});
export const getTournament=(env,id)=>withDatabase(env,async db=>mapped(db,await repo.findById(db,id)));
export const getTournamentByCode=(env,code)=>withDatabase(env,async db=>mapped(db,await repo.findByCode(db,code)));
export async function createTournament(env,input,identity){const data=validate(input);return withTransaction(env,async db=>{
  const user=await identityActor(db,identity);if(user.role!=='ORGANIZER')throw new TournamentError('Only ORGANIZER users can create tournaments',403);
  await repo.lockCreation(db);const code='TRN'+(BigInt(await repo.highestCode(db))+1n).toString().padStart(6,'0');
  const row=await repo.insert(db,data,code,user);await nested(db,row.id,input);return mapped(db,row);
});}
// Pre-publication statuses only: this product has no user-facing Draft workflow (create already
// lands directly on PENDING_ADMIN_APPROVAL), so PENDING_ADMIN_APPROVAL is the normal editable
// state, not an edge case. DRAFT is kept only for the rare orphaned row left by a create that
// never reached its automatic submit step. REJECTED stays editable so an organizer can fix and
// have it reviewed again. Editing NEVER changes status — no resubmission step exists.
const PRE_APPROVAL_STATUSES=['DRAFT','REJECTED','PENDING_ADMIN_APPROVAL'];
export function updateTournament(env,id,input,identity){object(input);return withTransaction(env,async db=>{
  const row=await repo.findById(db,id,true);if(!row)throw new TournamentError('Tournament not found',404);await owner(db,row,identity);
  if(!PRE_APPROVAL_STATUSES.includes(row.status))throw new TournamentError('Only tournaments awaiting or pending admin approval can be edited',409);
  if(input.organizerId&&input.organizerId!==row.organizer_id)throw new TournamentError('Organizer cannot be reassigned');
  const updated=await repo.update(db,id,validate(input,row));await nested(db,id,input);return mapped(db,updated);
});}
// Pre-publication-only hard delete: registration (eligibility.service.js: TOURNAMENT_NOT_PUBLISHED)
// only opens once a tournament is PUBLISHED, so a tournament in one of PRE_APPROVAL_STATUSES can
// never have real registrations/teams/fixtures/matches/results/medals yet — deleting it here
// cannot destroy player-facing history. repo.deleteTournament still purges every tournament-linked
// table defensively, in dependency order, in case any exist despite that guarantee.
export function deleteTournament(env,id,identity){return withTransaction(env,async db=>{
  const row=await repo.findById(db,id,true);if(!row)throw new TournamentError('Tournament not found',404);await owner(db,row,identity);
  if(!PRE_APPROVAL_STATUSES.includes(row.status))throw new TournamentError('Only tournaments awaiting or pending admin approval can be deleted',409);
  await repo.deleteTournament(db,id);return {deleted:true,id};
});}
export function transitionTournament(env,id,action,input,identity){object(input);return withTransaction(env,async db=>{
  const row=await repo.findById(db,id,true);if(!row)throw new TournamentError('Tournament not found',404);
  let user;if(action==='submit'){user=await owner(db,row,identity);}else{
    user=await identityActor(db,identity);if(user.role!=='ADMIN'||user.id===row.organizer_id)throw new TournamentError('A separate ADMIN is required',403);
  }
  const allowed={submit:['DRAFT','REJECTED'],approve:['PENDING_ADMIN_APPROVAL'],reject:['PENDING_ADMIN_APPROVAL'],publish:['APPROVED']};
  if(!allowed[action]?.includes(row.status))throw new TournamentError('INVALID_TOURNAMENT_STATUS_TRANSITION',409);
  if(action==='submit'){validate({},row);if(!(await repo.categories(db,id)).length)throw new TournamentError('At least one category is required before submission');}
  const reason=action==='reject'&&input.reason!=null?text(input.reason,'reason'):null;
  const out=await repo.transition(db,id,action,user.id,reason);if(action==='approve'||action==='reject'){const title=action==='approve'?'Tournament approved':'Tournament rejected';const verb=action==='approve'?'approved':'rejected';await emit(db,{recipientId:row.organizer_id,recipientRole:'ORGANIZER',type:`TOURNAMENT_${action.toUpperCase()}`,title,message:`Your tournament ${row.name} has been ${verb}.`,tournamentId:id,dedupeKey:`TOURNAMENT_${action}:${id}`});}return mapped(db,out);
});}
export function closeCategoryRegistration(env,tournamentId,categoryId,identity){return withTransaction(env,async db=>{
  const row=await repo.findById(db,tournamentId,true);if(!row)throw new TournamentError('Tournament not found',404);
  if(!identity)throw new TournamentError('Authentication required',401);
  const user=await actor(db,identity.sub);if(user.role!=='ADMIN'&&(user.role!=='ORGANIZER'||user.id!==row.organizer_id))throw new TournamentError('Not authorized for this tournament',403);
  const categoryRow=(await repo.categories(db,tournamentId)).find(c=>c.id===categoryId);if(!categoryRow)throw new TournamentError('Category not found',404);
  if(categoryRow.registration_phase==='CLOSED')return mapped(db,row);
  await repo.closeCategory(db,tournamentId,categoryId);return mapped(db,row);
});}
