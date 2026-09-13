export function nextPowerOfTwo(n){let size=1;while(size<n)size*=2;return size;}

export function buildLeaguePairings(participants){
  const pairings=[];
  for(let i=0;i<participants.length;i++)for(let j=i+1;j<participants.length;j++)pairings.push({participant1:participants[i],participant2:participants[j]});
  return pairings;
}

export function buildKnockoutBracket(participants){
  const size=nextPowerOfTwo(participants.length),matches=[],rounds=[],byeCount=size-participants.length,slots=[];let cursor=0;
  for(let i=0;i<byeCount;i++){slots.push(participants[cursor++],null);}while(cursor<participants.length)slots.push(participants[cursor++]);while(slots.length<size)slots.push(null);let previous=[];
  for(let i=0;i<size;i+=2){const key=`R1M${i/2+1}`,a=slots[i]??null,b=slots[i+1]??null;const match={key,round:1,index:i/2+1,participant1:a,participant2:b,source1:null,source2:null,next:null,nextSlot:null,byeParticipant:a&&!b?a:null};matches.push(match);previous.push(match);}
  rounds.push(previous);
  let round=2;
  while(previous.length>1){const current=[];for(let i=0;i<previous.length;i+=2){const left=previous[i],right=previous[i+1],m={key:`R${round}M${i/2+1}`,round,index:i/2+1,participant1:left.byeParticipant&&!right.byeParticipant?left.byeParticipant:null,participant2:right.byeParticipant&&!left.byeParticipant?right.byeParticipant:null,source1:left.byeParticipant?null:left.key,source2:right.byeParticipant?null:right.key,next:null,nextSlot:null,byeParticipant:null};left.next=m.key;left.nextSlot=1;right.next=m.key;right.nextSlot=2;matches.push(m);current.push(m);}rounds.push(current);previous=current;round++;}
  return {bracketSize:size,byeCount:size-participants.length,rounds,matches};
}
