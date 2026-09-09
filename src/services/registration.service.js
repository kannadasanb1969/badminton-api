import {withDatabase,withTransaction} from '../db/database.js';
import * as repo from '../repositories/registration.repository.js';
import {findById as findUser} from '../repositories/user.repository.js';
import {findById as findPlayer} from '../repositories/player.repository.js';
import {RegistrationError,validateRegistrationInput,checkEligibility} from './eligibility.service.js';
import {mapRegistrationRow} from '../mappers/registration.mapper.js';
import {emit} from './notification.events.js';
export {RegistrationError};
async function authorize(db,env,input,playerId) {
  // TODO: Replace development client IDs with verified bearer/session identity.
  // Fail closed outside explicit local development; IDs are not credentials.
  if(env.AUTH_MODE!=='development'||env.ENVIRONMENT==='production'||env.NODE_ENV==='production')throw new RegistrationError('Authenticated registration identity is not configured',503,'AUTH_NOT_CONFIGURED');
  if(input.playerId&&input.playerId!==playerId)throw new RegistrationError('Cannot act for another player',403,'FORBIDDEN');
  if(input.userId!==undefined){
    const user=typeof input.userId==='string'?await findUser(db,input.userId):null;
    const player=await findPlayer(db,playerId);
    if(!user||!user.is_active||user.role!=='PLAYER'||player?.user_id!==user.id)throw new RegistrationError('User does not own this player profile',403,'FORBIDDEN');
  }
}
export const previewEligibility=(env,input)=>withTransaction(env,db=>checkEligibility(db,input));
export async function createRegistration(env,input){input=validateRegistrationInput(input);return withTransaction(env,async db=>{
  await authorize(db,env,input,input.playerId);await repo.lockWrites(db);
  const decision=await checkEligibility(db,input);
  if(!decision.eligible)throw new RegistrationError('Registration is not eligible',409,'NOT_ELIGIBLE',decision.reasons);
  const code='REG'+(BigInt(await repo.nextNumber(db))+1n).toString().padStart(6,'0');
  // Partner fields suffice; team_id stays null until Phase 6.
  const eventType=input.partner?'DOUBLES':'SINGLES';
  const saved=await repo.insert(db,input,eventType,code);const player=await findPlayer(db,input.playerId);if(player?.user_id)await emit(db,{recipientId:player.user_id,recipientRole:'PLAYER',type:'REGISTRATION_CONFIRMED',title:'Registration confirmed',message:'Your tournament registration was successful.',tournamentId:input.tournamentId,categoryId:input.categoryId,dedupeKey:`REGISTRATION:${saved.id}`});return mapRegistrationRow(saved);
});}
export const listRegistrations=(env,filters={})=>withDatabase(env,async db=>(await repo.list(db,filters)).map(mapRegistrationRow));
export const getRegistration=(env,id)=>withDatabase(env,async db=>{const row=await repo.findById(db,id);if(!row)throw new RegistrationError('Registration not found',404,'REGISTRATION_NOT_FOUND');return mapRegistrationRow(row);});
export function cancelRegistration(env,id,input={}) {return withTransaction(env,async db=>{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new RegistrationError('JSON object required');
  await repo.lockWrites(db);const row=await repo.findById(db,id);if(!row)throw new RegistrationError('Registration not found',404,'REGISTRATION_NOT_FOUND');
  await authorize(db,env,input,row.player_id);
  if(row.status==='CANCELLED')return mapRegistrationRow(row);
  if(!['PENDING','REGISTERED','CONFIRMED'].includes(row.status))throw new RegistrationError('Registration cannot be cancelled',409,'INVALID_STATUS_TRANSITION');
  if(row.team_id)throw new RegistrationError('Team-linked cancellation requires the future team workflow',409,'TEAM_WORKFLOW_REQUIRED');
  return mapRegistrationRow(await repo.cancel(db,id));
});}
