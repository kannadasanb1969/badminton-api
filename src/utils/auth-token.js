const encoder = new TextEncoder();
function b64(bytes){return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function unb64(value){const s=value.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(value.length/4)*4,'=');return Uint8Array.from(atob(s),c=>c.charCodeAt(0));}
async function key(secret,usage){return crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,[usage]);}
export async function issueAccessToken(env,user,{ttlSeconds=900}={}){
  if(!env.AUTH_TOKEN_SECRET) throw new Error('Auth token secret is not configured');
  const payload=b64(encoder.encode(JSON.stringify({sub:user.id,role:user.role,exp:Math.floor(Date.now()/1000)+ttlSeconds})));
  const sig=b64(new Uint8Array(await crypto.subtle.sign('HMAC',await key(env.AUTH_TOKEN_SECRET,'sign'),encoder.encode(payload))));
  return `${payload}.${sig}`;
}
export async function verifyAccessToken(env,token){
  if(!env.AUTH_TOKEN_SECRET||typeof token!=='string') return null;
  const [payload,sig]=token.split('.');if(!payload||!sig)return null;
  const ok=await crypto.subtle.verify('HMAC',await key(env.AUTH_TOKEN_SECRET,'verify'),unb64(sig),encoder.encode(payload));if(!ok)return null;
  try {const data=JSON.parse(new TextDecoder().decode(unb64(payload)));if(!data.sub||!data.role||data.exp<=Math.floor(Date.now()/1000))return null;return data;}catch{return null;}
}
