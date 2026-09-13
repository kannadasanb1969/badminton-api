let n=0;
export function createPlayer({role='PLAYER',userId=`user-${++n}`,id=`player-${n}`}={}){return {id,userId,role,full_name:`Player ${n}`};}
export function createFriendlyMatch({id=`friendly-${++n}`,creatorPlayerId,eventType='DOUBLES',format='KNOCKOUT',participantIds=[]}={}){return {id,friendly_match_code:`FRND${String(n).padStart(6,'0')}`,creator_player_id:creatorPlayerId,event_type:eventType,format,max_players:eventType==='DOUBLES'?8:6,status:'OPEN',participantIds};}
export function createApprovedParticipant(match,player){match.participantIds.push(player.id);return player;}
export function createPlayers(count){return Array.from({length:count},()=>createPlayer());}
