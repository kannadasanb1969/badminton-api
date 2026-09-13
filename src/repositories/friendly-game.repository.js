export const createFriendlyGameRepository = (db) => ({
  match: async (fixtureId, matchId, lock = true) => (await db.query(`SELECT * FROM friendly_game_matches WHERE id=$1 AND friendly_match_id=$2${lock ? ' FOR UPDATE' : ''}`, [matchId, fixtureId])).rows[0],
  creator: async (fixtureId) => (await db.query('SELECT creator_player_id FROM friendly_matches WHERE id=$1', [fixtureId])).rows[0]?.creator_player_id,
  userIdForPlayer: async (playerId) => (await db.query('SELECT user_id FROM player_profiles WHERE id=$1', [playerId])).rows[0]?.user_id,
  start: async (matchId, points) => (await db.query("UPDATE friendly_game_matches SET status='LIVE',winning_points=$2,started_at=COALESCE(started_at,NOW()),updated_at=NOW() WHERE id=$1 RETURNING *", [matchId, points])).rows[0],
  score: async (matchId, scoreA, scoreB) => (await db.query("UPDATE friendly_game_matches SET participant1_score=$2,participant2_score=$3,updated_at=NOW() WHERE id=$1 AND status='LIVE' RETURNING *", [matchId, scoreA, scoreB])).rows[0],
  history: (matchId, scoreA, scoreB, action, actor) => db.query('INSERT INTO friendly_match_score_history(match_id,participant1_score,participant2_score,action,actor_player_id) VALUES($1,$2,$3,$4,$5)', [matchId, scoreA, scoreB, action, actor]),
  complete: async (matchId, winner, winnerType) => (await db.query("UPDATE friendly_game_matches SET status='COMPLETED',winner_id=$2,winner_type=$3,completed_at=NOW(),updated_at=NOW() WHERE id=$1 RETURNING *", [matchId, winner, winnerType])).rows[0],
  downstream: async (matchId) => (await db.query('SELECT * FROM friendly_game_matches WHERE id=$1 FOR UPDATE', [matchId])).rows[0],
  advance: async (matchId, column, winner, winnerType) => (await db.query(`UPDATE friendly_game_matches SET ${column}_id=$2,${column}_type=$3,updated_at=NOW() WHERE id=$1 AND status='SCHEDULED' RETURNING *`, [matchId, winner, winnerType])).rows[0],
});
