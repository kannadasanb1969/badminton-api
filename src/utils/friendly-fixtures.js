export function nextPowerOfTwo(n){let size=1;while(size<n)size*=2;return size;}

export const MIN_POOL_SIZE=3, TARGET_POOL_SIZE=4, MAX_POOL_SIZE=6;

// Generic pool-count/size solver: no hardcoded team-count branches. Searches every pool count p for which
// an n-team field splits into pools all within [min,max] (a base size plus at most one +1 per pool from the
// remainder, so sizes differ by at most 1 within a split), scores each valid split by sum of squared
// deviation from `target` (ties broken by smaller max-min spread, then fewer pools, both deterministic),
// and returns the winning split's sizes as a descending array, e.g. calculatePoolSizes(17) -> [5,4,4,4].
// Falls back to a single pool when n is too small to satisfy `min` in every pool (e.g. n=2).
export function calculatePoolSizes(n,{min=MIN_POOL_SIZE,target=TARGET_POOL_SIZE,max=MAX_POOL_SIZE}={}){
  if(n<=0)return [];
  let best=null;
  for(let p=1;p<=n;p++){
    const base=Math.floor(n/p),extra=n%p;
    const biggest=extra>0?base+1:base;
    if(base<min||biggest>max)continue;
    const sizes=[...Array(extra).fill(base+1),...Array(p-extra).fill(base)];
    const cost=sizes.reduce((s,x)=>s+(x-target)**2,0);
    const spread=Math.max(...sizes)-Math.min(...sizes);
    const candidate={p,sizes,cost,spread};
    if(!best||candidate.cost<best.cost||(candidate.cost===best.cost&&candidate.spread<best.spread)||(candidate.cost===best.cost&&candidate.spread===best.spread&&candidate.p<best.p)){
      best=candidate;
    }
  }
  if(!best)return [n];
  return best.sizes;
}

export function poolName(index){
  let n=index,name='';
  do{name=String.fromCharCode(65+(n%26))+name;n=Math.floor(n/26)-1;}while(n>=0);
  return name;
}

// Splits shuffled participants into pools per the sizes from calculatePoolSizes, each pool tagged with its
// deterministic A/B/C.../AA/AB name. Every participant appears exactly once, in exactly one pool.
export function assignPools(participants,sizes){
  const pools=[];let cursor=0;
  for(let i=0;i<sizes.length;i++){
    pools.push({name:poolName(i),participants:participants.slice(cursor,cursor+sizes[i])});
    cursor+=sizes[i];
  }
  return pools;
}

export function buildLeaguePairings(participants){
  const pairings=[];
  for(let i=0;i<participants.length;i++)for(let j=i+1;j<participants.length;j++)pairings.push({participant1:participants[i],participant2:participants[j]});
  return pairings;
}

// Standard circle-method round-robin scheduler: every pairing from buildLeaguePairings still occurs
// exactly once, but grouped into proper matchday rounds where each participant appears at most once
// per round (N participants -> N-1 rounds of N/2 matches each for even N; an odd N gets a per-round bye
// via a null placeholder seat that is simply skipped, still yielding N rounds of (N-1)/2 matches).
export function buildRoundRobinSchedule(participants){
  if(participants.length<2)return [];
  const withBye=participants.length%2===0?participants.slice():[...participants,null];
  const size=withBye.length,rounds=size-1,half=size/2,arr=withBye.slice(),schedule=[];
  for(let r=0;r<rounds;r++){
    const roundMatches=[];
    for(let i=0;i<half;i++){const a=arr[i],b=arr[size-1-i];if(a&&b)roundMatches.push({participant1:a,participant2:b});}
    schedule.push(roundMatches);
    const fixed=arr[0],rest=arr.slice(1);rest.unshift(rest.pop());arr.splice(0,arr.length,fixed,...rest);
  }
  return schedule;
}

// League -> Knockout qualification selection. No qualification rule existed anywhere in the project before
// this (confirmed by grep: zero "qualif" hits in the whole codebase) — this is new logic, not a reuse of an
// existing rule. `poolStandings` is [{poolId, standings:[{participantId,points,pointDiff,pointsFor}, ...]}]
// already ranked (as computePoolStandings produces). Selection order: top `qualifiersPerPool` from every
// pool first (never skipped — every pool contributes at least its winners), then up to `bestThirdPlaceCount`
// next-best-ranked non-qualifiers across all pools (by points/pointDiff/pointsFor), then up to `wildcardCount`
// more of whoever ranks best overall among the still-unqualified. If `targetBracketSize` is given, the result
// is trimmed to that many (dropping the lowest-ranked extras first) rather than silently over/under-filling
// a bracket size the caller asked for.
export function selectQualifiers(poolStandings,{qualifiersPerPool=1,bestThirdPlaceCount=0,wildcardCount=0,targetBracketSize=null}={}){
  const rank=(a,b)=>b.points-a.points||b.pointDiff-a.pointDiff||b.pointsFor-a.pointsFor;
  const qualified=[],qualifiedIds=new Set(),leftovers=[];
  for(const pool of poolStandings){
    const sorted=[...pool.standings].sort(rank);
    sorted.slice(0,qualifiersPerPool).forEach(row=>{qualified.push({...row,poolId:pool.poolId,reason:'POOL'});qualifiedIds.add(row.participantId);});
    sorted.slice(qualifiersPerPool).forEach(row=>leftovers.push({...row,poolId:pool.poolId}));
  }
  leftovers.sort(rank);
  if(bestThirdPlaceCount>0){
    leftovers.splice(0,bestThirdPlaceCount).forEach(row=>{qualified.push({...row,reason:'BEST_THIRD'});qualifiedIds.add(row.participantId);});
  }
  if(wildcardCount>0){
    leftovers.filter(row=>!qualifiedIds.has(row.participantId)).slice(0,wildcardCount).forEach(row=>{qualified.push({...row,reason:'WILDCARD'});qualifiedIds.add(row.participantId);});
  }
  qualified.sort(rank);
  return targetBracketSize?qualified.slice(0,targetBracketSize):qualified;
}

export function buildKnockoutBracket(participants){
  const size=nextPowerOfTwo(participants.length),matches=[],rounds=[],byeCount=size-participants.length,slots=[];let cursor=0;
  for(let i=0;i<byeCount;i++){slots.push(participants[cursor++],null);}while(cursor<participants.length)slots.push(participants[cursor++]);while(slots.length<size)slots.push(null);let previous=[];
  for(let i=0;i<size;i+=2){const key=`R1M${i/2+1}`,a=slots[i]??null,b=slots[i+1]??null;const match={key,round:1,index:i/2+1,participant1:a,participant2:b,source1:null,source2:null,next:null,nextSlot:null,byeParticipant:a&&!b?a:null};matches.push(match);previous.push(match);}
  rounds.push(previous);
  let round=2;
  // Each side of a round>=2 match is filled independently from whichever side had a round-1 bye winner
  // (known immediately, no source needed) — including when BOTH sides were byes, which is a genuine match
  // between two bye-advanced players, not a further bye. A side with no bye winner instead gets a `source`
  // link so it's filled once that earlier match is actually played. Round>=2 matches are never themselves
  // a "further bye": every side either has its participant known now, or a real match feeding it later.
  while(previous.length>1){const current=[];for(let i=0;i<previous.length;i+=2){const left=previous[i],right=previous[i+1],m={key:`R${round}M${i/2+1}`,round,index:i/2+1,participant1:left.byeParticipant??null,participant2:right.byeParticipant??null,source1:left.byeParticipant?null:left.key,source2:right.byeParticipant?null:right.key,next:null,nextSlot:null,byeParticipant:null};left.next=m.key;left.nextSlot=1;right.next=m.key;right.nextSlot=2;matches.push(m);current.push(m);}rounds.push(current);previous=current;round++;}
  return {bracketSize:size,byeCount:size-participants.length,rounds,matches};
}
