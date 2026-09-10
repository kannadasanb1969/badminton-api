import * as service from '../services/registration.service.js';
import {successResponse,errorResponse} from '../utils/response.js';
import {verifyAccessToken} from '../utils/auth-token.js';
async function body(request,optional=false){try{const text=await request.text();return !text&&optional?{}:JSON.parse(text);}catch{throw new service.RegistrationError('Valid JSON required');}}
export async function handleRegistrationRoutes(request,env){try{
  const authHeader=request.headers.get('Authorization');
  const auth=authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
  const identity=auth?await verifyAccessToken(env,auth):null;
  const url=new URL(request.url);const path=url.pathname.replace(/\/$/,'');
  if(path==='/api/eligibility/check'){
    if(request.method!=='POST')return errorResponse('Method not allowed',405);
    return successResponse(await service.previewEligibility(env,await body(request)));
  }
  let parts;try{parts=path.split('/').slice(3).map(decodeURIComponent);}catch{throw new service.RegistrationError('Invalid URL encoding');}
  const filters=Object.fromEntries(url.searchParams);
  if(!parts.length){
    if(request.method==='GET')return successResponse(await service.listRegistrations(env,filters));
    if(request.method==='POST')return successResponse(await service.createRegistration(env,await body(request),identity),201);
  }else if(parts.length===1&&parts[0]){
    if(request.method==='GET')return successResponse(await service.getRegistration(env,parts[0]));
  }else if(parts.length===2&&['player','tournament'].includes(parts[0])){
    if(request.method==='GET')return successResponse(await service.listRegistrations(env,{...filters,[parts[0]+'Id']:parts[1]}));
  }else if(parts.length===2&&parts[1]==='cancel'){
    if(request.method==='POST')return successResponse(await service.cancelRegistration(env,parts[0],await body(request,true),identity));
  }else return errorResponse('API endpoint not found',404);
  return errorResponse('Method not allowed',405);
}catch(error){
  if(error instanceof service.RegistrationError)return Response.json({success:false,message:error.message,code:error.code,...(error.reasons.length?{reasons:error.reasons}:{})},{status:error.status});
  if(error.code==='23505')return Response.json({success:false,message:'Registration already exists',code:'ALREADY_REGISTERED'},{status:409});
  if(error.code==='23503')return errorResponse('Registration references an unavailable record',409);
  console.error('Registration request failed',{code:error.code??'UNKNOWN'});return errorResponse('Unable to complete registration request',500);
}}
