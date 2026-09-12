import { withDatabase } from '../db/database.js';
import { verifyAccessToken } from '../utils/auth-token.js';

export class RealtimeError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function getMatchRoomName(matchId) { return `match:${matchId}`; }

async function canView(db, matchId, identity) {
  const match = (await db.query(`
    SELECT m.id,m.tournament_id,m.participant1_id,m.participant1_type,
           m.participant2_id,m.participant2_type,t.organizer_id
    FROM matches m JOIN tournaments t ON t.id=m.tournament_id WHERE m.id=$1`, [matchId])).rows[0];
  if (!match) throw new RealtimeError('Match not found', 404);
  if (!identity) throw new RealtimeError('Authentication required', 401);
  if (identity.role === 'ADMIN' || identity.role === 'ORGANIZER' && identity.sub === match.organizer_id) return match;
  if (identity.role !== 'PLAYER') throw new RealtimeError('Not authorized to view this match', 403);
  const allowed = (await db.query(`
    SELECT 1 FROM matches m
    WHERE m.id=$1 AND (
      (m.participant1_type='PLAYER' AND EXISTS (SELECT 1 FROM player_profiles p WHERE p.id=m.participant1_id AND p.user_id=$2))
      OR (m.participant2_type='PLAYER' AND EXISTS (SELECT 1 FROM player_profiles p WHERE p.id=m.participant2_id AND p.user_id=$2))
      OR (m.participant1_type='TEAM' AND EXISTS (SELECT 1 FROM teams tm JOIN player_profiles p ON p.id IN (tm.player1_id,tm.player2_id) WHERE tm.id=m.participant1_id AND p.user_id=$2))
      OR (m.participant2_type='TEAM' AND EXISTS (SELECT 1 FROM teams tm JOIN player_profiles p ON p.id IN (tm.player1_id,tm.player2_id) WHERE tm.id=m.participant2_id AND p.user_id=$2))
    )`, [matchId, identity.sub])).rows.length > 0;
  if (!allowed) throw new RealtimeError('Not authorized to view this match', 403);
  return match;
}

export async function authorizeRealtime(env, matchId, token) {
  const identity = token ? await verifyAccessToken(env, token) : null;
  return withDatabase(env, db => canView(db, matchId, identity));
}

export async function broadcastMatchEvent(env, matchId, event) {
  if (!env.MATCH_LIVE_ROOM) return;
  try {
    const id = env.MATCH_LIVE_ROOM.idFromName(getMatchRoomName(matchId));
    await env.MATCH_LIVE_ROOM.get(id).fetch('https://match-live-room/broadcast', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(event),
    });
  } catch (error) {
    console.error('Realtime broadcast failed', { matchId, eventType: event?.type, message: error.message });
  }
}
