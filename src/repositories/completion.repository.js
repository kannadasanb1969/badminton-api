// A completed early round, unfinished sibling, or ambiguous top round is not a final.
export async function completedKnockoutFinals(db, tournamentIds) {
  if (!tournamentIds.length) return [];
  return (await db.query(`SELECT m.* FROM matches m JOIN fixtures f ON f.id=m.fixture_id
    WHERE m.tournament_id=ANY($1::text[]) AND f.status='PUBLISHED' AND f.format='KNOCKOUT'
      AND m.status='COMPLETED' AND m.completed_at IS NOT NULL AND m.next_match_id IS NULL
      AND m.participant1_id IS NOT NULL AND m.participant2_id IS NOT NULL
      AND m.participant1_id<>m.participant2_id
      AND m.participant1_score<>m.participant2_score
      AND m.winner_id=CASE WHEN m.participant1_score>m.participant2_score THEN m.participant1_id ELSE m.participant2_id END
      AND NOT EXISTS (SELECT 1 FROM matches pending WHERE pending.fixture_id=m.fixture_id AND pending.status<>'COMPLETED')
      AND m.round_number=(SELECT MAX(r.round_number) FROM matches r WHERE r.fixture_id=m.fixture_id)
      AND 1=(SELECT COUNT(*) FROM matches r WHERE r.fixture_id=m.fixture_id AND r.round_number=m.round_number)`, [tournamentIds])).rows;
}

export async function completedResultSummaries(db, tournamentIds) {
  const finals = await completedKnockoutFinals(db, tournamentIds);
  if (!finals.length) return new Map();
  const rows = (await db.query(`WITH participants AS (
      SELECT id,'PLAYER'::text AS type,full_name AS name,player_code AS code FROM player_profiles
      UNION ALL
      SELECT team.id,'TEAM',
        CASE WHEN COALESCE(p1.full_name,g1.full_name) IS NOT NULL AND COALESCE(p2.full_name,g2.full_name) IS NOT NULL
          THEN COALESCE(p1.full_name,g1.full_name)||' / '||COALESCE(p2.full_name,g2.full_name) END,team.team_code
        FROM teams team
        LEFT JOIN player_profiles p1 ON p1.id=team.player1_id AND team.player1_type<>'GUEST'
        LEFT JOIN guest_players g1 ON g1.id=team.player1_id AND team.player1_type='GUEST'
        LEFT JOIN player_profiles p2 ON p2.id=team.player2_id AND team.player2_type<>'GUEST'
        LEFT JOIN guest_players g2 ON g2.id=team.player2_id AND team.player2_type='GUEST'
    ) SELECT r.*,w.name AS winner_name,w.code AS winner_code,u.name AS runner_up_name,u.code AS runner_up_code
      FROM results r
      LEFT JOIN participants w ON w.id=r.winner_participant_id AND w.type=r.winner_participant_type
      LEFT JOIN participants u ON u.id=r.runner_up_participant_id AND u.type=r.runner_up_participant_type
      WHERE r.tournament_id=ANY($1::text[])`, [tournamentIds])).rows;
  const summaries = new Map();
  for (const row of rows) {
    const final = finals.find(match => match.tournament_id===row.tournament_id && match.category_id===row.category_id);
    if (!final || !row.completed_at) continue;
    const runnerUp = final.winner_id===final.participant1_id ? final.participant2_id : final.participant1_id;
    if (row.winner_participant_id!==final.winner_id || row.runner_up_participant_id!==runnerUp) continue;
    summaries.set(row.category_id, {
      id:row.id,tournamentId:row.tournament_id,categoryId:row.category_id,eventType:row.event_type,
      winnerParticipantId:row.winner_participant_id,winnerParticipantName:row.winner_name??'',winnerParticipantCode:row.winner_code??'',
      runnerUpParticipantId:row.runner_up_participant_id,runnerUpParticipantName:row.runner_up_name??'',runnerUpParticipantCode:row.runner_up_code??'',
      completedAt:row.completed_at,
    });
  }
  return summaries;
}

export function withCompletion(tournament, summaries) {
  const categories = tournament.categories.map(category => {
    const result = summaries.get(category.id);
    return {...category, completionStatus:result?'COMPLETED':'IN_PROGRESS', result:result?{
      ...result,tournamentCode:tournament.tournamentCode,tournamentName:tournament.name,categoryName:category.name,
    }:null};
  });
  const completed = categories.length>0 && categories.every(category=>category.completionStatus==='COMPLETED');
  return {...tournament, categories, completionStatus:completed?'COMPLETED':'IN_PROGRESS',
    result:completed && categories.length===1 ? categories[0].result : null};
}
