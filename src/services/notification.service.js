import {withDatabase,withTransaction} from '../db/database.js';import * as repo from '../repositories/notification.repository.js';import {mapNotificationRow} from '../mappers/notification.mapper.js';
export class NotificationError extends Error{constructor(m,s=400){super(m);this.status=s;}}
const valid=async(db,id)=>{const u=(await db.query('SELECT id FROM users WHERE id=$1 AND is_active=true',[id])).rows[0];if(!u)throw new NotificationError('Active user required',403);};
export const list=(env,id)=>withDatabase(env,async db=>{await valid(db,id);return (await repo.list(db,id)).map(mapNotificationRow)});
export const unread=(env,id)=>withDatabase(env,async db=>{await valid(db,id);return {count:await repo.countUnread(db,id)} });
export const read=(env,id,nid)=>withDatabase(env,async db=>{await valid(db,id);const n=await repo.markRead(db,nid,id);if(!n)throw new NotificationError('Notification not found',404);return mapNotificationRow(n)});
export const readAll=(env,id)=>withTransaction(env,async db=>{await valid(db,id);return {updated:await repo.markAll(db,id)}});
export const create=(env,n)=>withDatabase(env,async db=>mapNotificationRow(await repo.create(db,n)));
