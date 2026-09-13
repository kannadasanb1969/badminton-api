export class FriendlyMatchMemoryRepository{
  constructor({state}={}){this.state=state??{matches:new Map(),players:new Map(),participants:new Map(),teams:new Map(),fixtures:new Map(),sequence:0};this.matches=this.state.matches;this.players=this.state.players;this.participantMap=this.state.participants;this.teamMap=this.state.teams;this.fixtures=this.state.fixtures;this.fixtures.add=(id)=>this.fixtures.set(id,{id,friendly_match_id:id});this.sequence=this.state.sequence??0;}
  id(prefix){return `${prefix}${++this.sequence}`;}
  addPlayer(p){this.players.set(p.id,p);return p;}
  addMatch(m){this.matches.set(m.id,m);this.participantMap.set(m.id,new Set(m.participantIds??[]));return m;}
  async participantsFor(id){return this.participants(id);}
  creator(userId){return [...this.players.values()].find(p=>p.userId===userId);}
  byId(id){return this.matches.get(id);}
  all(){return [...this.matches.values()];}
  participants(a,b){const id=b??a;return [...(this.participantMap.get(id)??[])].map(player_id=>({player_id,full_name:this.players.get(player_id)?.full_name}));}
  participant(id,p){return this.participantMap.get(id)?.has(p)?{player_id:p}:undefined;}
  teams(a,b){const id=b??a;return [...this.teamMap.values()].filter(t=>t.matchId===id).map(t=>({...t,team_code:t.id,members:t.playerIds.map(player_id=>({player_id}))}));}
  member(id,p){return this.teams(id).find(t=>t.playerIds.includes(p));}
  fixture(id){return [...this.fixtures.values()].find(x=>x.friendly_match_id===id);}
  addTeam(id,a,b){if(this.member(id,a)||this.member(id,b))throw new Error('duplicate team membership');const t={id:this.id('team-'),matchId:id,playerIds:[a,b]};this.teamMap.set(t.id,t);return t;}
  participantsRows(id){return this.participants(id).map(x=>({...x,full_name:this.players.get(x.player_id)?.full_name,player_code:this.players.get(x.player_id)?.id}));}
}
