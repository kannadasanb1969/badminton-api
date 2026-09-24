// Reconciles persisted knockout winners and BYE advances. Safe to call repeatedly.
export async function resolveFriendlyKnockout(db, friendlyMatchId) {
  const games = (await db.query(
    'SELECT * FROM friendly_game_matches WHERE friendly_match_id=$1 ORDER BY round_number,match_number FOR UPDATE',
    [friendlyMatchId],
  )).rows;

  for (const game of games) {
    const hasOneSide = Boolean(game.participant1_id) !== Boolean(game.participant2_id);
    const missingSideHasSource = !game.participant1_id
      ? Boolean(game.source_match_1_id)
      : Boolean(game.source_match_2_id);

    if (game.status === 'SCHEDULED' && hasOneSide && !missingSideHasSource) {
      const winnerId = game.participant1_id ?? game.participant2_id;
      const winnerType = game.participant1_id ? game.participant1_type : game.participant2_type;
      const completed = (await db.query(
        `UPDATE friendly_game_matches
         SET status='COMPLETED', winner_id=$2, winner_type=$3,
             completed_at=COALESCE(completed_at,NOW()), updated_at=NOW()
         WHERE id=$1 AND status='SCHEDULED' RETURNING *`,
        [game.id, winnerId, winnerType],
      )).rows[0];
      if (completed) Object.assign(game, completed);
    }

    if (game.status !== 'COMPLETED' || !game.winner_id || !game.next_match_id) continue;
    const target = (await db.query('SELECT * FROM friendly_game_matches WHERE id=$1 FOR UPDATE', [game.next_match_id])).rows[0];
    if (!target) throw new Error('Knockout progression target not found');
    const column = game.next_match_slot === 1 ? 'participant1' : 'participant2';
    if (target[`${column}_id`] && (target[`${column}_id`] !== game.winner_id || target[`${column}_type`] !== game.winner_type)) {
      throw new Error('Knockout progression slot is already occupied by another participant');
    }
    if (!target[`${column}_id`]) {
      await db.query(
        `UPDATE friendly_game_matches
         SET ${column}_id=$2, ${column}_type=$3, updated_at=NOW()
         WHERE id=$1 AND status='SCHEDULED'`,
        [target.id, game.winner_id, game.winner_type],
      );
    }
  }
}
