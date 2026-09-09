const camel = (k) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
export function mapFixtureRow(row, participants = [], matches = []) {
  if (!row) return null;
  const out = Object.fromEntries(Object.entries(row).map(([k, v]) => [camel(k), v]));
  return { ...out, participants, matches };
}
export function mapTeamRow(row, players = []) {
  if (!row) return null;
  return { id: row.id, teamCode: row.team_code, tournamentId: row.tournament_id, categoryId: row.category_id,
    player1: players[0] ?? { type: row.player1_type === 'GUEST' ? 'GUEST' : 'PLAYER', id: row.player1_id },
    player2: players[1] ?? { type: row.player2_type === 'GUEST' ? 'GUEST' : 'PLAYER', id: row.player2_id },
    partnerStatus: row.partner_status, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at };
}
