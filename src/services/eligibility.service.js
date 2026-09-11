import * as repo from '../repositories/registration.repository.js';
import {mapPlayerRow} from '../mappers/player.mapper.js';
export class RegistrationError extends Error {
  constructor(message,status=400,code='INVALID_REQUEST',reasons=[]) {super(message);this.status=status;this.code=code;this.reasons=reasons;}
}
export function validateRegistrationInput(input) {
  if(!input||typeof input!=='object'||Array.isArray(input))throw new RegistrationError('JSON object required');
  for(const key of ['tournamentId','categoryId','playerId'])if(typeof input[key]!=='string'||!input[key].trim())throw new RegistrationError(`${key} is required`);
  if(input.partner!=null && (typeof input.partner!=='object'||Array.isArray(input.partner)))throw new RegistrationError('partner must be an object');
  if(input.partner && (typeof input.partner.id!=='string'||!input.partner.id.trim()))throw new RegistrationError('partner.id is required');
  return {...input,partner:input.partner??null};
}
// Shared by eligibility preview and the final check inside the insert transaction.
export async function checkEligibility(db,input) {
  input=validateRegistrationInput(input);
  const {tournament,category,player,partner}=await repo.context(db,input);
  for(const [row,code,message] of [[tournament,'TOURNAMENT_NOT_FOUND','Tournament not found'],[category,'CATEGORY_NOT_FOUND','Category not found'],[player,'PLAYER_NOT_FOUND','Player not found']])if(!row)throw new RegistrationError(message,404,code);
  const reasons=[];const add=(code,message)=>reasons.push({code,message});
  if(tournament.status!=='PUBLISHED')add('TOURNAMENT_NOT_PUBLISHED','Tournament is not open for registration');
  if(category.tournament_id!==tournament.id)add('CATEGORY_NOT_IN_TOURNAMENT','Category does not belong to this tournament');
  const date=value=>value instanceof Date?value.toISOString().slice(0,10):String(value).slice(0,10);
  if((tournament.registration_close_date&&tournament.today>date(tournament.registration_close_date))||category.registration_phase!=='OPEN'||category.registration_closed_at)add('REGISTRATION_CLOSED','Registration has closed or is paused');
  if(!['SINGLES','DOUBLES'].includes(category.event_type))add('EVENT_TYPE_NOT_SUPPORTED','Unsupported event type');
  if(category.event_type==='SINGLES'&&input.partner)throw new RegistrationError('SINGLES cannot include a partner');
  if(category.event_type==='DOUBLES'&&!input.partner)add('PARTNER_REQUIRED','A doubles partner is required');
  if(input.partner){
    if(!['PLAYER','GUEST'].includes(input.partner.type))throw new RegistrationError('Partner type must be PLAYER or GUEST',400,'INVALID_PARTNER_TYPE');
    if(!partner)throw new RegistrationError('Partner not found',404,'PARTNER_NOT_FOUND');
    if(input.partner.type==='PLAYER'&&partner.id===player.id)add('SELF_PARTNER_NOT_ALLOWED','You cannot select yourself as partner');
    if(input.partner.type==='GUEST'&&(partner.linked_player_id||partner.claimed_at))add('GUEST_ALREADY_CLAIMED','Select the linked registered player instead of this guest');
  }
  const participants=[{row:player,type:'PLAYER',label:'Player'},...(partner?[{row:partner,type:input.partner.type,label:'Partner'}]:[])];
  for(const {row,type,label} of participants){
    if(row.profile_status!=='ACTIVE')add(type==='PLAYER'&&row.id===player.id?'PLAYER_INACTIVE':'PARTNER_INACTIVE',`${label} profile must be active`);
    if(['MALE','FEMALE'].includes(category.gender_eligibility)&&row.gender!==category.gender_eligibility)add('GENDER_NOT_ELIGIBLE',`${label} does not meet gender eligibility`);
    if(category.min_age!=null||category.max_age!=null){
      const age=mapPlayerRow(row,new Date(tournament.today+'T00:00:00Z')).age;
      if(age===null||!Number.isFinite(age)||(category.min_age!=null&&age<category.min_age)||(category.max_age!=null&&age>category.max_age))add('AGE_NOT_ELIGIBLE',`${label} does not meet age requirements`);
    }
    if(category.medalists_allowed===false&&await repo.medalist(db,row.id,type))add('MEDALIST_NOT_ALLOWED',`${label} has medal history; medalists are not allowed`);
    if(await repo.participation(db,tournament.id,category.id,row.id,type))add(label==='Player'?'ALREADY_REGISTERED':'PARTNER_ALREADY_REGISTERED',`${label} is already participating in this category`);
  }
  const history=await repo.existingHistory(db,category.id,player.id);
  if(history&&!['PENDING','REGISTERED','CONFIRMED'].includes(history.status))add('REGISTRATION_HISTORY_EXISTS','A prior registration exists; this schema does not allow a new registration for the same player and category');
  if(category.max_teams!=null&&await repo.countActive(db,category.id)>=category.max_teams)add('CATEGORY_FULL','Category capacity has been reached');
  // No authoritative player skill/classification data exists in these profiles.
  if(category.beginner_only||category.pure_beginner_only||category.open_players_allowed===false)add('ELIGIBILITY_REVIEW_REQUIRED','This category requires a player classification not available in V1');
  const playerReasons=reasons.filter(r=>r.message.startsWith('Player ')||r.code.startsWith('PLAYER_')||r.code==='ALREADY_REGISTERED');
  const partnerReasons=reasons.filter(r=>r.message.startsWith('Partner ')||r.code.startsWith('PARTNER_')||r.code==='GUEST_ALREADY_CLAIMED'||r.code==='MEDALIST_NOT_ALLOWED');
  return {eligible:reasons.length===0,playerEligible:playerReasons.length===0,playerReasons,partnerEligible:partner?partnerReasons.length===0:null,partnerReasons,reasons};
}
