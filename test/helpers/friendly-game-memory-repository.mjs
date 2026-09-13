export class FriendlyGameMemoryRepository{
  constructor({state}={}){this.state=state;this.historyRows=state.scoreHistory??(state.scoreHistory=[]);}
  match=async(fid,mid)=>{const m=this.state.gameMatches.get(mid);return m&&m.friendly_match_id===fid?m:undefined};
  creator=async fid=>this.state.matches.get(fid)?.creator_player_id;
  userIdForPlayer=async playerId=>this.state.players.get(playerId)?.userId;
  async start(id,p){const m=this.state.gameMatches.get(id);m.status='LIVE';m.winning_points=p;return m;}
  async score(id,a,b){const m=this.state.gameMatches.get(id);m.participant1_score=a;m.participant2_score=b;return m;}
  async history(id,a,b,action,actor){this.historyRows.push({match_id:id,participant1_score:a,participant2_score:b,action,actor_player_id:actor});}
  async complete(id,w,t){const m=this.state.gameMatches.get(id);m.status='COMPLETED';m.winner_id=w;m.winner_type=t;return m;}
  async downstream(id){return this.state.gameMatches.get(id);}
  async advance(id,col,w,t){const m=this.state.gameMatches.get(id);m[`${col}_id`]=w;m[`${col}_type`]=t;return m;}
}
