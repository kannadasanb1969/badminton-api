import { withDatabase, withTransaction } from '../db/database.js';
import * as otpStore from '../repositories/auth.repository.js';
import * as users from '../repositories/user.repository.js';
import { mapUserRow } from '../mappers/user.mapper.js';
import { mapPlayerRow } from '../mappers/player.mapper.js';
import { issueAccessToken } from '../utils/auth-token.js';

// Development provider only. Production must install a real delivery provider.
const FIXED_OTP = '12345';
const MAX_ATTEMPTS = 5;
// TEMPORARY ADMIN ACCESS RULE: replace with proper DB-based admin provisioning.
const TEMP_ADMIN_MOBILE = '+918888888888';
export class AuthError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
function development(env) {
  if (!['development','fixed'].includes(env.AUTH_MODE ?? 'fixed')) {
    throw new AuthError('OTP provider is not configured', 503);
  }
}
function object(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AuthError('JSON object required',400);
}
export function mobileValue(value) {
  if (typeof value !== 'string' || !/^\+?[0-9]{10,15}$/.test(value.trim())) throw new AuthError('Valid mobile number required',400);
  const digits=value.trim().replace(/^\+/, '');
  return digits.length===10 ? `+91${digits}` : digits.startsWith('91') && digits.length===12 ? `+${digits}` : `+${digits}`;
}
function roleValue(role) {
  if (!['PLAYER','ORGANIZER','ADMIN'].includes(role)) throw new AuthError('Valid role required',400);
  return role;
}
async function digest(otp, salt) {
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(otp),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:new TextEncoder().encode(salt),iterations:100000},key,256);
  return Array.from(new Uint8Array(bits),v=>v.toString(16).padStart(2,'0')).join('');
}
async function hashOtp(otp) {
  const salt=crypto.randomUUID(); return `pbkdf2$${salt}$${await digest(otp,salt)}`;
}
async function matches(otp, stored) {
  const [scheme,salt,hash]=String(stored).split('$');
  if (scheme!=='pbkdf2' || !salt || !hash) return false;
  const actual=await digest(otp,salt); let difference=actual.length ^ hash.length;
  for(let i=0;i<actual.length;i++) difference |= actual.charCodeAt(i) ^ (hash.charCodeAt(i)||0);
  return difference===0;
}
export async function requestOtp(env,input) {
  development(env);object(input);const mobile=mobileValue(input.mobile);
  const hash=await hashOtp(FIXED_OTP);
  await withTransaction(env,async db=>{await otpStore.lockMobile(db,mobile);await otpStore.createOtp(db,mobile,hash);});
  return {success:true,message:'OTP generated successfully',...(env.AUTH_MODE==='development'&&env.ENVIRONMENT!=='production'&&env.NODE_ENV!=='production'?{devOtp:FIXED_OTP}:{})};
}
export async function verifyOtp(env,input) {
  development(env);object(input);const mobile=mobileValue(input.mobile);const role=input.role==null?null:roleValue(input.role);
  if(typeof input.otp!=='string' || !/^\d{5}$/.test(input.otp)) throw new AuthError('Five-digit OTP required',400);
  // Return failures from the transaction so attempt counters/expiry are committed.
  const result=await withTransaction(env,async db=>{
    await otpStore.lockMobile(db,mobile);const otp=await otpStore.latestOtp(db,mobile);
    if(!otp || otp.status!=='PENDING' || otp.attempt_count>=MAX_ATTEMPTS) return {error:'Invalid or expired OTP',status:401};
    if(!otp.unexpired) {await otpStore.setStatus(db,otp.id,'EXPIRED');return {error:'Invalid or expired OTP',status:401};}
    if(!await matches(input.otp,otp.otp_hash)) {await otpStore.failedAttempt(db,otp.id);return {error:'Invalid or expired OTP',status:401};}
    let user=role==='PLAYER'?await users.userLinkedToPlayerMobile(db,mobile):(await users.findByMobile(db,mobile,role))[0];
    if(!role) user=(await users.findByMobile(db,mobile)).find(candidate=>candidate.is_active&&candidate.role!=='ADMIN');
    if(!user&&role==='ORGANIZER') user=await users.createRoleUser(db,mobile,'ORGANIZER');
    if(!user) user=(await users.findByMobile(db,mobile,role))[0];
    if((!user && role!=='PLAYER' && role!==null) || (user && !user.is_active)) return {error:'Authentication not permitted',status:403};
    if(!user && (role==='PLAYER'||role===null)) user=await users.userLinkedToPlayerMobile(db,mobile);
    if(!user) user=await users.createPlayerUser(db,mobile);
    await otpStore.setStatus(db,otp.id,'VERIFIED');
    const profiles=role==='PLAYER'?await users.linkedProfiles(db,user.id):[];
    return {user:mapUserRow(user),playerProfile:profiles.length===1?mapPlayerRow(profiles[0]):null,accessToken:await issueAccessToken(env,user)};
  });
  if(result.error) throw new AuthError(result.error,result.status);
  return result;
}
export async function selectWorkspace(env,input,identity){object(input);const workspace=String(input.workspace||'').toUpperCase();if(!['PLAYER','ORGANIZER','ADMIN'].includes(workspace))throw new AuthError('Valid workspace required',400);if(!identity)throw new AuthError('Authentication required',401);return withTransaction(env,async db=>{const current=await users.findById(db,identity.sub);if(!current||!current.is_active)throw new AuthError('Authentication not permitted',403);if(workspace==='ADMIN'&&current.mobile!==TEMP_ADMIN_MOBILE)throw new AuthError('Admin access not permitted',403);if(workspace!=='ADMIN'&&current.role==='ADMIN')throw new AuthError('Authentication not permitted',403);const user=workspace==='ADMIN'?await users.createRoleUser(db,current.mobile,'ADMIN'):workspace==='ORGANIZER'?await users.createRoleUser(db,current.mobile,'ORGANIZER'):await users.createRoleUser(db,current.mobile,'PLAYER');const profiles=workspace==='PLAYER'?await users.linkedProfiles(db,user.id):[];return {user:mapUserRow(user),playerProfile:profiles.length===1?mapPlayerRow(profiles[0]):null,accessToken:await issueAccessToken(env,user)};});}
// Compatibility alias; no independent login bypass or fake token generation.
export const login = verifyOtp;
export async function getUser(env,id) {
  return withDatabase(env,async db=>{const user=await users.findById(db,id);if(!user) throw new AuthError('User not found',404);return mapUserRow(user);});
}
export async function getUserByMobile(env,mobile,role) {
  mobile=mobileValue(mobile);if(role!==null) roleValue(role);
  return withDatabase(env,async db=>{const rows=await users.findByMobile(db,mobile,role);if(!rows.length) throw new AuthError('User not found',404);if(rows.length>1) throw new AuthError('Specify role to select a user',400);return mapUserRow(rows[0]);});
}
