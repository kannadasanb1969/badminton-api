import {withDatabase,withTransaction} from '../db/database.js';
import * as repo from '../repositories/tournament.repository.js';
import {findById as findUser} from '../repositories/user.repository.js';
import {mapTournament} from '../mappers/tournament.mapper.js';
import {emit} from './notification.events.js';
export class TournamentError extends Error {
  constructor(message,status=400){super(message);this.status=status;}
}
const fields={name:'name',description:'description',tournamentDate:'tournament_date',reportingTime:'reporting_time',registrationCloseDate:'registration_close_date',registrationCloseTime:'registration_close_time',venueName:'venue_name',venueAddress:'venue_address',mapLink:'map_link',format:'format',prizes:'prizes',shuttle:'shuttle',scoringFormat:'scoring_format'};
const aliases={startDate:'tournamentDate',registrationEndDate:'registrationCloseDate',venue:'venueName',location:'venueAddress',fixtureFormat:'format'};
function object(value){if(!value || typeof value!=='object' || Array.isArray(value))throw new TournamentError('JSON object required');}
function text(value,label){if(typeof value!=='string'||!value.trim())throw new TournamentError(`${label} is required`);return value.trim();}
function date(value,label){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new TournamentError(`${label} must be YYYY-MM-DD`);
  const d=new Date(value+'T00:00:00Z');if(Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==value)throw new TournamentError(`Invalid ${label}`);return value;
}
function validate(input,existing={}){
  object(input);const source={...input};
  // Compatibility-only endDate, registrationStartDate and entryFee are ignored and returned as null.
  // TODO: Add storage in a future migration only if the product needs persistent support.
  for(const key of ['status','approvedBy','approvedAt','publishedAt','submittedAt','rejectedAt','rejectedBy','rejectionReason','id','tournamentCode'])if(Object.hasOwn(source,key))throw new TournamentError(`${key} cannot be set through profile edits`);
  for(const [alias,target] of Object.entries(aliases))if(Object.hasOwn(source,alias)){
    source[target]=source[alias];
  }
  const result=Object.fromEntries(Object.values(fields).map(k=>[k,existing[k]??null]));result.format??='KNOCKOUT';
  for(const [key,column] of Object.entries(fields))if(Object.hasOwn(source,key))result[column]=source[key];
  result.name=text(result.name,'name');
  for(const [key,column] of Object.entries(fields))if(result[column]!==null&&typeof result[column]!=='string'&&!(result[column] instanceof Date))throw new TournamentError(`${key} must be a string or null`);
  if(result.tournament_date instanceof Date)result.tournament_date=result.tournament_date.toISOString().slice(0,10);
  if(result.registration_close_date instanceof Date)result.registration_close_date=result.registration_close_date.toISOString().slice(0,10);
  date(result.tournament_date,'tournamentDate');
  if(result.registration_close_date!==null){date(result.registration_close_date,'registrationCloseDate');if(result.registration_close_date>result.tournament_date)throw new TournamentError('registrationCloseDate must not be after tournamentDate');}
  for(const key of ['reporting_time','registration_close_time'])if(result[key]!==null&&!/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(result[key]))throw new TournamentError('Invalid time');
  if(!['KNOCKOUT','LEAGUE','ROUND_ROBIN','GROUP_KNOCKOUT'].includes(result.format))throw new TournamentError('Invalid fixture format');return result;
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
async function mapped(db,row){if(!row)throw new TournamentError('Tournament not found',404);const counts=await repo.registrationCounts(db,[row.id]);const cs=await repo.categories(db,row.id);const categories=cs.map(c=>{const x=counts.categories.get(c.id);return {...c,registeredPlayerCount:x?.registered_player_count??0,registeredEntryCount:x?.registered_entry_count??0,registeredTeamCount:x?.registered_team_count??0};});const t=counts.tournaments.get(row.id);return {...mapTournament(row,categories,await repo.rules(db,row.id)),registeredPlayerCount:t?.registered_player_count??0,registeredEntryCount:t?.registered_entry_count??0,registeredTeamCount:t?.registered_team_count??0};}
// TODO: Replace client-supplied actor IDs with verified request/session identity.
// Database role checks are a temporary phase-4 mechanism, not authentication.
async function actor(db,id){const user=typeof id==='string'?await findUser(db,id):null;if(!user||!user.is_active)throw new TournamentError('Authorization required',403);return user;}
async function owner(db,row,input){const user=await actor(db,input.adminUserId??input.organizerId);if(user.role!=='ADMIN'&&(user.role!=='ORGANIZER'||user.id!==row.organizer_id))throw new TournamentError('Not authorized for this tournament',403);return user;}
export const listTournaments=(env,filters={})=>withDatabase(env,async db=>{const rows=await repo.findAll(db,filters);if(!rows.length)return [];const counts=await repo.registrationCounts(db,rows.map(r=>r.id));return Promise.all(rows.map(async row=>{const cs=await repo.categories(db,row.id);const categories=cs.map(c=>{const x=counts.categories.get(c.id);return {...c,registeredPlayerCount:x?.registered_player_count??0,registeredEntryCount:x?.registered_entry_count??0,registeredTeamCount:x?.registered_team_count??0};});const t=counts.tournaments.get(row.id);return {...mapTournament(row,categories,await repo.rules(db,row.id)),registeredPlayerCount:t?.registered_player_count??0,registeredEntryCount:t?.registered_entry_count??0,registeredTeamCount:t?.registered_team_count??0};}));});
export const getTournament=(env,id)=>withDatabase(env,async db=>mapped(db,await repo.findById(db,id)));
export const getTournamentByCode=(env,code)=>withDatabase(env,async db=>mapped(db,await repo.findByCode(db,code)));
export async function createTournament(env,input){const data=validate(input);return withTransaction(env,async db=>{
  const user=await actor(db,input.organizerId);if(user.role!=='ORGANIZER')throw new TournamentError('Only ORGANIZER users can create tournaments',403);
  await repo.lockCreation(db);const code='TRN'+(BigInt(await repo.highestCode(db))+1n).toString().padStart(6,'0');
  const row=await repo.insert(db,data,code,user);await nested(db,row.id,input);return mapped(db,row);
});}
export function updateTournament(env,id,input){object(input);return withTransaction(env,async db=>{
  const row=await repo.findById(db,id,true);if(!row)throw new TournamentError('Tournament not found',404);await owner(db,row,input);
  if(!['DRAFT','REJECTED'].includes(row.status))throw new TournamentError('Only DRAFT or REJECTED tournaments can be edited',409);
  if(input.organizerId&&input.organizerId!==row.organizer_id)throw new TournamentError('Organizer cannot be reassigned');
  const updated=await repo.update(db,id,validate(input,row));await nested(db,id,input);return mapped(db,updated);
});}
export function transitionTournament(env,id,action,input){object(input);return withTransaction(env,async db=>{
  const row=await repo.findById(db,id,true);if(!row)throw new TournamentError('Tournament not found',404);
  let user;if(action==='submit'){user=await owner(db,row,input);}else{
    user=await actor(db,input.adminUserId);if(user.role!=='ADMIN'||user.id===row.organizer_id)throw new TournamentError('A separate ADMIN is required',403);
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
