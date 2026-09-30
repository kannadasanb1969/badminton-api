export async function findPair(db, firstPlayerId, secondPlayerId, lock = false) {
  const suffix = lock ? " FOR UPDATE" : "";
  return (await db.query(`
    SELECT * FROM player_connections
    WHERE pair_low_player_id = LEAST($1::text, $2::text)
      AND pair_high_player_id = GREATEST($1::text, $2::text)${suffix}`,
    [firstPlayerId, secondPlayerId])).rows[0];
}

export async function insert(db, requesterId, recipientId) {
  return (await db.query(`
    INSERT INTO player_connections (requester_player_id, recipient_player_id)
    VALUES ($1, $2) RETURNING *`, [requesterId, recipientId])).rows[0];
}

export async function updatePending(db, id, requesterId, recipientId) {
  return (await db.query(`
    UPDATE player_connections
    SET requester_player_id = $2, recipient_player_id = $3,
        status = 'PENDING', accepted_at = NULL, updated_at = NOW()
    WHERE id = $1 RETURNING *`, [id, requesterId, recipientId])).rows[0];
}

export async function updateStatus(db, id, status) {
  return (await db.query(`
    UPDATE player_connections
    SET status = $2, accepted_at = CASE WHEN $2 = 'ACCEPTED' THEN NOW() ELSE NULL END,
        updated_at = NOW()
    WHERE id = $1 RETURNING *`, [id, status])).rows[0];
}

export async function findById(db, id, lock = false) {
  return (await db.query(`SELECT * FROM player_connections WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id])).rows[0];
}

export async function discover(db, playerId, search = null) {
  return (await db.query(`
    SELECT p.*, c.id AS connection_id, c.status AS connection_status,
      c.requester_player_id AS connection_requester_id,
      c.recipient_player_id AS connection_recipient_id,
      c.created_at AS connection_created_at, c.accepted_at AS connection_accepted_at
    FROM player_profiles p
    LEFT JOIN player_connections c
      ON c.pair_low_player_id = LEAST($1::text, p.id)
      AND c.pair_high_player_id = GREATEST($1::text, p.id)
    WHERE p.id <> $1 AND p.profile_status = 'ACTIVE'
      AND ($2::text IS NULL OR lower(p.full_name) LIKE lower($2) OR lower(p.player_code) LIKE lower($2))
    ORDER BY lower(p.full_name), p.id`, [playerId, search ? `%${search}%` : null])).rows;
}

export async function acceptedFor(db, playerId) {
  return (await db.query(`
    SELECT p.*, c.id AS connection_id,
      CASE WHEN c.requester_player_id = $1 THEN 'OUTGOING' ELSE 'INCOMING' END AS connection_direction
    FROM player_connections c
    JOIN player_profiles p ON p.id = CASE
      WHEN c.requester_player_id = $1 THEN c.recipient_player_id
      ELSE c.requester_player_id END
    WHERE (c.requester_player_id = $1 OR c.recipient_player_id = $1)
      AND c.status = 'ACCEPTED'
    ORDER BY lower(p.full_name), p.id`, [playerId])).rows;
}

export async function pendingFor(db, playerId, direction) {
  const column = direction === "received" ? "recipient_player_id" : "requester_player_id";
  const other = direction === "received" ? "requester_player_id" : "recipient_player_id";
  return (await db.query(`
    SELECT c.id AS connection_id, c.status, c.created_at AS connection_created_at,
      c.updated_at AS connection_updated_at, p.*
    FROM player_connections c
    JOIN player_profiles p ON p.id = c.${other}
    WHERE c.${column} = $1 AND c.status = 'PENDING'
    ORDER BY c.created_at DESC`, [playerId])).rows;
}

export async function deleteAcceptedFor(db, connectionId, playerId) {
  return (await db.query(`
    DELETE FROM player_connections
    WHERE id = $1 AND status = 'ACCEPTED'
      AND (requester_player_id = $2 OR recipient_player_id = $2)
    RETURNING *`, [connectionId, playerId])).rows[0];
}
