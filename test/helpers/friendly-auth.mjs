export const creatorIdentity=(player)=>({userId:player.userId,playerId:player.id});
export const otherIdentity=(player)=>({userId:player.userId,playerId:player.id});
export const noIdentity=()=>null;
