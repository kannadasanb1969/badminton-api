import * as auth from '../services/auth.service.js';
import {successResponse,errorResponse} from '../utils/response.js';
async function body(request) {
  try {return await request.json();} catch {throw new auth.AuthError('Valid JSON required',400);}
}
export async function handleAuthRoutes(request,env) {
  try {
    const url=new URL(request.url);const path=url.pathname.replace(/\/$/,'');
    if(['/api/auth/request-otp','/api/auth/verify-otp','/api/auth/login'].includes(path)) {
      if(request.method!=='POST') return errorResponse('Method not allowed',405);
      const input=await body(request);
      if(path.endsWith('/request-otp')) return Response.json(await auth.requestOtp(env,input));
      return successResponse(await (path.endsWith('/login')?auth.login:auth.verifyOtp)(env,input));
    }
    const match=path.match(/^\/api\/users\/(?:mobile\/([^/]+)|([^/]+))$/);
    if(match) {
      if(request.method!=='GET') return errorResponse('Method not allowed',405);
      let value;try {value=decodeURIComponent(match[1]??match[2]);}catch {throw new auth.AuthError('Invalid URL encoding',400);}
      return successResponse(await (match[1]?auth.getUserByMobile(env,value,url.searchParams.get('role')):auth.getUser(env,value)));
    }
    return errorResponse('API endpoint not found',404);
  } catch(error) {
    if(error instanceof auth.AuthError) return errorResponse(error.message,error.status);
    console.error('Auth request failed',{code:error.code??'UNKNOWN'});
    return errorResponse('Unable to complete authentication request',500);
  }
}
