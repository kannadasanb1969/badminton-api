import * as service from '../services/tournament.service.js';
import {successResponse,errorResponse} from '../utils/response.js';
async function body(request){try{return await request.json();}catch{throw new service.TournamentError('Valid JSON required');}}
export async function handleTournamentRoutes(request,env){try{
  const url=new URL(request.url);let parts;try{parts=url.pathname.replace(/\/$/,'').split('/').slice(3).map(decodeURIComponent);}catch{throw new service.TournamentError('Invalid URL encoding');}
  if(parts.length===0){
    if(request.method==='GET')return successResponse(await service.listTournaments(env,Object.fromEntries(url.searchParams)));
    if(request.method==='POST')return successResponse(await service.createTournament(env,await body(request)),201);
  }else if(parts.length===2&&parts[0]==='code'){
    if(request.method==='GET')return successResponse(await service.getTournamentByCode(env,parts[1]));
  }else if(parts.length===1&&parts[0]){
    if(request.method==='GET')return successResponse(await service.getTournament(env,parts[0]));
    if(request.method==='PUT')return successResponse(await service.updateTournament(env,parts[0],await body(request)));
    // Permanent DELETE is unsupported: tournament history must be retained.
  }else if(parts.length===2&&['submit','approve','reject','publish'].includes(parts[1])){
    if(request.method==='POST')return successResponse(await service.transitionTournament(env,parts[0],parts[1],await body(request)));
  }else if(parts.length===4&&parts[1]==='categories'&&parts[3]==='close'){
    if(request.method==='POST')return successResponse(await service.closeCategoryRegistration(env,parts[0],parts[2],await body(request)));
  }else return errorResponse('API endpoint not found',404);
  return errorResponse('Method not allowed',405);
}catch(error){
  if(error instanceof service.TournamentError)return errorResponse(error.message,error.status);
  if(error.code==='23505')return errorResponse('Tournament or category already exists',409);
  if(error.code==='23503')return errorResponse('Referenced record prevents this change',409);
  if(['22001','22007','22008','22P02','23514','23502'].includes(error.code))return errorResponse('Invalid tournament data',400);
  console.error('Tournament request failed',{code:error.code??'UNKNOWN'});return errorResponse(error.message||'Unable to complete tournament request',500);
}}
