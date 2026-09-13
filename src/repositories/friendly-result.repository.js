export const createFriendlyResultRepository = (db) => ({
  match: async (id, lock = false) => (await db.query(`SELECT * FROM friendly_matches WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0],
  creator: async (id) => (await db.query('SELECT creator_player_id FROM friendly_matches WHERE id=$1', [id])).rows[0]?.creator_player_id,
  userIdForPlayer: async (id) => (await db.query('SELECT user_id FROM player_profiles WHERE id=$1', [id])).rows[0]?.user_id,
  fixture: async (id) => (await db.query('SELECT * FROM friendly_fixtures WHERE friendly_match_id=$1 ORDER BY created_at DESC LIMIT 1', [id])).rows[0],
  games: async (id) => (await db.query('SELECT * FROM friendly_game_matches WHERE friendly_match_id=$1 ORDER BY round_number,match_number', [id])).rows,
  result: async (id) => (await db.query('SELECT * FROM friendly_results WHERE friendly_match_id=$1', [id])).rows[0],
  upsertResult: async (id, matchId, winnerId, winnerType, runnerUpId, runnerUpType) => (await db.query(`INSERT INTO friendly_results(friendly_match_id,match_id,winner_id,winner_type,runner_up_id,runner_up_type) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(friendly_match_id) DO UPDATE SET match_id=EXCLUDED.match_id,winner_id=EXCLUDED.winner_id,winner_type=EXCLUDED.winner_type,runner_up_id=EXCLUDED.runner_up_id,runner_up_type=EXCLUDED.runner_up_type WHERE friendly_results.winner_id=EXCLUDED.winner_id AND friendly_results.runner_up_id IS NOT DISTINCT FROM EXCLUDED.runner_up_id RETURNING *`, [id, matchId, winnerId, winnerType, runnerUpId, runnerUpType])).rows[0],
  status: async (id, value) => (await db.query('UPDATE friendly_matches SET status=$2,updated_at=NOW() WHERE id=$1 RETURNING *', [id, value])).rows[0],
  deleteChildren: async (id) => db.query('DELETE FROM friendly_matches WHERE id=$1', [id]),
});
