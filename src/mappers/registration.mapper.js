export function mapRegistrationRow(row) {
  if(!row)return null;
  return {id:row.id,registrationCode:row.registration_code,tournamentId:row.tournament_id,
    categoryId:row.category_id,playerId:row.player_id,eventType:row.event_type,status:row.status,
    teamId:row.team_id,partnerId:row.partner_id,partnerType:row.partner_type==='FULL'?'PLAYER':row.partner_type,
    partner:row.partner_id?{id:row.partner_id,type:row.partner_type==='FULL'?'PLAYER':row.partner_type}:null,
    registeredAt:row.registered_at,cancelledAt:row.cancelled_at,createdAt:row.created_at,updatedAt:row.updated_at};
}
