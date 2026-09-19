// Resolves knockout BYE branches inside the caller's existing transaction.
// A BYE is represented by a COMPLETED game with a winner and no score; it is
// deliberately not treated as a played/scored match.
export async function resolveFriendlyKnockoutByes(db, friendlyMatchId) {
  const rounds = await db.query(
    'SELECT * FROM friendly_game_matches WHERE friendly_match_id=$1 ORDER BY round_number,match_number FOR UPDATE',
    [friendlyMatchId],
  );
  const rows = rounds.rows;
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const isBye = (row) => row.status === 'COMPLETED' && row.winner_id &&
    row.participant1_score == null && row.participant2_score == null;
  const markBye = async (row, winner, winnerType) => {
    if (row.status !== 'SCHEDULED' || !winner || !winnerType) return false;
    const updated = await db.query(
      "UPDATE friendly_game_matches SET status='COMPLETED',winner_id=$2,winner_type=$3,completed_at=COALESCE(completed_at,NOW()),updated_at=NOW() WHERE id=$1 AND status='SCHEDULED' RETURNING *",
      [row.id, winner, winnerType],
    );
    if (updated.rows[0]) { Object.assign(row, updated.rows[0]); return true; }
    return false;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (row.round_number === 1 && row.status === 'SCHEDULED') {
        const hasOne = Boolean(row.participant1_id) !== Boolean(row.participant2_id);
        if (hasOne) {
          changed = (await markBye(row, row.participant1_id || row.participant2_id, row.participant1_type || row.participant2_type)) || changed;
        }
      }
    }
    for (const row of rows) {
      if (row.status !== 'SCHEDULED' || (!row.source_match_1_id && !row.source_match_2_id)) continue;
      const source1 = byId.get(String(row.source_match_1_id));
      const source2 = byId.get(String(row.source_match_2_id));
      if (!source1 || !source2 || source1.status !== 'COMPLETED' || source2.status !== 'COMPLETED') continue;
      // BYE-vs-BYE is an invalid bracket state: never fabricate a winner.
      if (isBye(source1) && isBye(source2)) continue;
      const winner1 = source1.winner_id ? { id: source1.winner_id, type: source1.winner_type } : null;
      const winner2 = source2.winner_id ? { id: source2.winner_id, type: source2.winner_type } : null;
      if (!winner1 || !winner2) continue;
      // The resolver is intentionally safe to call from fixture reads and
      // completion transactions. Do not treat an already-applied assignment
      // as a change, otherwise the convergence loop never terminates.
      if (String(row.participant1_id || '') === String(winner1.id) &&
          String(row.participant1_type || '') === String(winner1.type || '') &&
          String(row.participant2_id || '') === String(winner2.id) &&
          String(row.participant2_type || '') === String(winner2.type || '')) continue;
      const result = await db.query(
        "UPDATE friendly_game_matches SET participant1_id=$2,participant1_type=$3,participant2_id=$4,participant2_type=$5,updated_at=NOW() WHERE id=$1 AND status='SCHEDULED' RETURNING *",
        [row.id, winner1.id, winner1.type, winner2.id, winner2.type],
      );
      if (result.rows[0]) { Object.assign(row, result.rows[0]); changed = true; }
    }
  }
  return rows;
}
