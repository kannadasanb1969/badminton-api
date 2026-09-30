import { withDatabase, withTransaction } from '../db/database.js';
import * as repo from '../repositories/friendly-match.repository.js';
import * as invitations from '../repositories/friendly-match-invitation.repository.js';
import * as connections from '../repositories/player-connection.repository.js';
import * as players from '../repositories/player.repository.js';
import { player, owned, FriendlyMatchError } from './friendly-match.service.js';
import { emit } from './notification.events.js';

async function acceptedConnectionIds(db, playerId) {
  return new Set((await connections.acceptedFor(db, playerId)).map((r) => String(r.id)));
}

// Invite-candidate list for the creator's "Invite Players" screen — only ACCEPTED connections
// are eligible (Phase 3 rule #2), each annotated with its live domain state so the UI never has
// to guess: JOINED (already a participant) / INVITED (active pending invitation) /
// REQUEST_PENDING (has an active normal join request — invite() would 409 on this, so the
// button must not look actionable; Phase 5 fix for the Phase 4 candidate-state gap) /
// UNAVAILABLE (match not open or at capacity) / AVAILABLE (can be invited now).
export const candidates = (env, id, identity) =>
  withDatabase(env, async (db) => {
    const p = await player(db, identity);
    const m = await owned(db, id, p);
    const connected = await connections.acceptedFor(db, p.id);
    const participantRows = await repo.participants(db, id);
    const participantIds = new Set(participantRows.map((r) => String(r.player_id)));
    const pendingInvited = new Set(
      (await invitations.forMatch(db, id))
        .filter((r) => r.status === 'PENDING')
        .map((r) => String(r.invited_player_id)),
    );
    const pendingRequested = new Set(
      (await repo.requests(db, id))
        .filter((r) => r.status === 'PENDING')
        .map((r) => String(r.player_id)),
    );
    const atCapacity = participantRows.length >= m.max_players;
    const matchOpen = m.status === 'OPEN';
    return connected.map((c) => {
      const cid = String(c.id);
      const state = participantIds.has(cid)
        ? 'JOINED'
        : pendingInvited.has(cid)
          ? 'INVITED'
          : pendingRequested.has(cid)
            ? 'REQUEST_PENDING'
            : !matchOpen || atCapacity
              ? 'UNAVAILABLE'
              : 'AVAILABLE';
      return { player: { id: c.id, fullName: c.full_name, playerCode: c.player_code }, state };
    });
  });

export const invite = (env, id, invitedPlayerId, identity) =>
  withTransaction(env, async (db) => {
    const p = await player(db, identity);
    // owned() locks the friendly_matches row (FOR UPDATE OF m) — this serializes every invite()
    // call for the same match, which is what makes the duplicate-invitation and capacity checks
    // below race-free, exactly like join()/decide() already rely on the same lock.
    const m = await owned(db, id, p);
    if (!invitedPlayerId) throw new FriendlyMatchError('invitedPlayerId is required', 400);
    if (String(invitedPlayerId) === String(p.id)) throw new FriendlyMatchError('You cannot invite yourself', 400);
    if (m.status !== 'OPEN') throw new FriendlyMatchError('Friendly match is not open', 409);
    const connectedIds = await acceptedConnectionIds(db, p.id);
    if (!connectedIds.has(String(invitedPlayerId))) throw new FriendlyMatchError('Player is not an accepted connection', 403);
    if (await repo.participant(db, id, invitedPlayerId)) throw new FriendlyMatchError('Player is already a participant', 409);
    // Only one unresolved participation intent per player+match: if a normal join request is
    // already active, direct the creator to the existing Approve/Reject flow instead of creating
    // a second, contradictory pending path (Phase 3 rule #16).
    if (await repo.request(db, id, invitedPlayerId)) throw new FriendlyMatchError('Player already has a pending join request — approve it from Join Requests instead', 409);
    if (await invitations.active(db, id, invitedPlayerId)) throw new FriendlyMatchError('An active invitation already exists for this player', 409);
    const count = (await repo.participants(db, id)).length;
    if (count >= m.max_players) throw new FriendlyMatchError('Friendly match is at capacity', 409);
    const row = await invitations.insert(db, id, p.id, invitedPlayerId);
    const target = await players.findById(db, invitedPlayerId);
    if (target?.user_id) {
      await emit(db, {
        recipientId: target.user_id,
        recipientRole: 'PLAYER',
        type: 'FRIENDLY_MATCH_INVITE',
        title: 'Friendly Match Invitation',
        message: `${p.full_name} invited you to ${m.title}.`,
        link: `friendly-invitation:${row.id}:${m.id}`,
        dedupeKey: `FRIENDLY_MATCH_INVITE:${row.id}`,
      });
    }
    return { invitationId: row.id, friendlyMatchId: id, status: 'PENDING' };
  });

export const acceptInvitation = (env, invitationId, identity) =>
  withTransaction(env, async (db) => {
    const p = await player(db, identity);
    const inv = await invitations.byId(db, invitationId, true);
    if (!inv) throw new FriendlyMatchError('Invitation not found', 404);
    if (inv.invited_player_id !== p.id) throw new FriendlyMatchError('Only the invited player can respond to this invitation', 403);
    if (inv.status !== 'PENDING') throw new FriendlyMatchError('Invitation is no longer pending', 409);
    // Re-check current eligibility from scratch (Phase 3 rule #7) — the old invitation is never
    // trusted as still-valid on its own. Lock the match row too, so a second invited player
    // racing for the last slot serializes behind whichever accept() commits first.
    const m = await repo.byId(db, inv.friendly_match_id, true);
    if (!m) throw new FriendlyMatchError('Friendly match not found', 404);
    if (m.status !== 'OPEN') throw new FriendlyMatchError('Friendly match is not open', 409);
    if (await repo.participant(db, m.id, p.id)) {
      // Already a participant through some other path (e.g. normal request approved in the
      // meantime) — resolve the invitation idempotently rather than inserting a duplicate row.
      const updated = await invitations.updateStatus(db, invitationId, 'ACCEPTED');
      return { invitationId: updated.id, friendlyMatchId: m.id, status: 'ACCEPTED' };
    }
    const count = (await repo.participants(db, m.id)).length;
    if (count >= m.max_players) throw new FriendlyMatchError('Friendly match is at capacity', 409);
    // Doubles rule (#9): this only ever inserts into friendly_match_participants — the same
    // table/shape used by every other approval path — never a team row, so the accepted player
    // becomes an approved UNPAIRED participant. Manual pairing/shuffle handles team formation.
    await repo.addParticipant(db, m.id, p.id);
    const updated = await invitations.updateStatus(db, invitationId, 'ACCEPTED');
    const creator = await players.findById(db, m.creator_player_id);
    if (creator?.user_id) {
      await emit(db, {
        recipientId: creator.user_id,
        recipientRole: 'PLAYER',
        type: 'FRIENDLY_MATCH_JOINED',
        title: 'Player Joined',
        message: `${p.full_name} joined ${m.title}.`,
        link: `friendly-match:${m.id}`,
        dedupeKey: `FRIENDLY_MATCH_JOINED:${updated.id}`,
      });
    }
    return { invitationId: updated.id, friendlyMatchId: m.id, status: 'ACCEPTED' };
  });

// Lets a notification recipient re-check the invitation's live status before showing/hiding
// Join Match / Decline — the notification row itself is never trusted as still-accurate
// (Phase 3 rule #14: invitation domain is the source of truth, not the notification).
export const getInvitation = (env, invitationId, identity) =>
  withDatabase(env, async (db) => {
    const p = await player(db, identity);
    const inv = await invitations.byId(db, invitationId);
    if (!inv) throw new FriendlyMatchError('Invitation not found', 404);
    if (inv.invited_player_id !== p.id && inv.inviter_player_id !== p.id) throw new FriendlyMatchError('Not authorized to view this invitation', 403);
    return { id: inv.id, friendlyMatchId: inv.friendly_match_id, status: inv.status };
  });

export const declineInvitation = (env, invitationId, identity) =>
  withTransaction(env, async (db) => {
    const p = await player(db, identity);
    const inv = await invitations.byId(db, invitationId, true);
    if (!inv) throw new FriendlyMatchError('Invitation not found', 404);
    if (inv.invited_player_id !== p.id) throw new FriendlyMatchError('Only the invited player can respond to this invitation', 403);
    if (inv.status !== 'PENDING') throw new FriendlyMatchError('Invitation is no longer pending', 409);
    const updated = await invitations.updateStatus(db, invitationId, 'DECLINED');
    return { invitationId: updated.id, status: 'DECLINED' };
  });
