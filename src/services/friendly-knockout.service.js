// The single Friendly Match knockout progression pipeline. It is called from
// existing completion/read transactions and is safe to call repeatedly.
export async function resolveFriendlyKnockoutByes(db, friendlyMatchId) {
  const rows = (await db.query('SELECT * FROM friendly_game_matches WHERE friendly_match_id=$1 ORDER BY round_number,match_number FOR UPDATE',[friendlyMatchId])).rows;
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const visited = new Set();
  const empty = (v) => v == null;
  const same = (row, slot, id, type) => String(row[`${slot}_id`] ?? '') === String(id ?? '') && row[`${slot}_type`] === type;
  const assign = async (target, slot, id, type) => {
    if (same(target, slot, id, type)) return false;
    if (!empty(target[`${slot}_id`])) throw new Error('Knockout progression slot is already occupied by another participant');
    const updated = await db.query(`UPDATE friendly_game_matches SET ${slot}_id=$2,${slot}_type=$3,updated_at=NOW() WHERE id=$1 AND status='SCHEDULED' RETURNING *`,[target.id,id,type]);
    if (updated.rows[0]) Object.assign(target, updated.rows[0]);
    return Boolean(updated.rows[0]);
  };
  const propagate = async (row) => {
    if (row.status !== 'COMPLETED' || !row.winner_id || !row.next_match_id) return false;
    if (visited.has(String(row.id))) return false;
    visited.add(String(row.id));
    const target = byId.get(String(row.next_match_id)) ?? (await db.query('SELECT * FROM friendly_game_matches WHERE id=$1 FOR UPDATE',[row.next_match_id])).rows[0];
    if (!target) throw new Error('Knockout progression target not found');
    byId.set(String(target.id), target);
    return assign(target, row.next_match_slot === 1 ? 'participant1' : 'participant2', row.winner_id, row.winner_type);
  };
  let changed = true;
  while (changed) {
    changed = false;
    // Empty slots with an upstream source are waiting slots, never BYEs.
    for (const row of rows) {
      if (row.status !== 'SCHEDULED') continue;
      const p1 = !empty(row.participant1_id), p2 = !empty(row.participant2_id);
      const sourceForMissing = !p1 ? row.source_match_1_id : !p2 ? row.source_match_2_id : null;
      if (p1 !== p2 && !sourceForMissing) {
        const winnerId = p1 ? row.participant1_id : row.participant2_id;
        const winnerType = p1 ? row.participant1_type : row.participant2_type;
        const updated = await db.query(`UPDATE friendly_game_matches SET status='COMPLETED',winner_id=$2,winner_type=$3,completed_at=COALESCE(completed_at,NOW()),updated_at=NOW() WHERE id=$1 AND status='SCHEDULED' RETURNING *`,[row.id,winnerId,winnerType]);
        if (updated.rows[0]) { Object.assign(row, updated.rows[0]); changed = true; }
      }
    }
    for (const row of rows) if (row.status === 'COMPLETED' && row.winner_id && row.next_match_id) { if (await propagate(row)) changed = true; }
    // Use source lineage only after every required upstream source is complete.
    for (const row of rows) {
      if (row.status !== 'SCHEDULED' || (!row.source_match_1_id && !row.source_match_2_id)) continue;
      const a = row.source_match_1_id ? byId.get(String(row.source_match_1_id)) : null;
      const b = row.source_match_2_id ? byId.get(String(row.source_match_2_id)) : null;
      if ((row.source_match_1_id && (!a || a.status !== 'COMPLETED')) || (row.source_match_2_id && (!b || b.status !== 'COMPLETED'))) continue;
      if (a?.winner_id && await assign(row,'participant1',a.winner_id,a.winner_type)) changed = true;
      if (b?.winner_id && await assign(row,'participant2',b.winner_id,b.winner_type)) changed = true;
    }
  }
  return rows;
}

// Compatibility export; both callers use the same authoritative pipeline.
export const resolveFriendlyKnockout = resolveFriendlyKnockoutByes;
