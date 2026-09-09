import {test,after} from 'node:test';import assert from 'node:assert/strict';import {Client} from 'pg';
import {requestOtp,verifyOtp} from '../src/services/auth.service.js';
const original={connect:Client.prototype.connect,end:Client.prototype.end,query:Client.prototype.query};
let calls=[];let otp;
Client.prototype.connect=async()=>{};Client.prototype.end=async()=>{};
Client.prototype.query=async function(sql,values){calls.push({sql,values});return {rows:sql.includes('SELECT *,')?[otp]:[]};};
after(()=>Object.assign(Client.prototype,original));
const env={AUTH_MODE:'development',HYPERDRIVE:{connectionString:'postgres://localhost/test'}};
test('production disables fixed OTP and verification',async()=>{
 for(const e of [{},{AUTH_MODE:'production'},{AUTH_MODE:'development',ENVIRONMENT:'production'}]) {
  await assert.rejects(requestOtp(e,{mobile:'9999999999'}),{status:503});
  await assert.rejects(verifyOtp(e,{mobile:'9999999999',otp:'123456',role:'PLAYER'}),{status:503});
 }
});
test('expired OTP commits expiry state and cannot create a user',async()=>{
 calls=[];otp={id:'otp',status:'PENDING',attempt_count:0,unexpired:false};
 await assert.rejects(verifyOtp(env,{mobile:'9999999999',otp:'123456',role:'PLAYER'}),{status:401});
 assert.ok(calls.some(c=>c.values?.includes('EXPIRED')));assert.equal(calls.at(-1).sql,'COMMIT');assert.ok(!calls.some(c=>c.sql.includes('INSERT INTO users')));
});
test('consumed OTP and attempt limit reject reuse',async()=>{
 for(const state of [{status:'VERIFIED',attempt_count:0},{status:'PENDING',attempt_count:5}]) {
  otp={id:'otp',unexpired:true,...state};await assert.rejects(verifyOtp(env,{mobile:'9999999999',otp:'123456',role:'PLAYER'}),{status:401});
 }
});
