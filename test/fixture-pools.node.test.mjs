import {test} from 'node:test';
import assert from 'node:assert/strict';
import {calculatePoolSizes,assignPools,poolName,buildRoundRobinSchedule,selectQualifiers,MIN_POOL_SIZE,MAX_POOL_SIZE} from '../src/utils/friendly-fixtures.js';

const ids=n=>Array.from({length:n},(_,i)=>({id:`P${i+1}`,type:'PLAYER'}));

const EXPECTED={16:[4,4,4,4],17:[5,4,4,4],20:[4,4,4,4,4],24:[4,4,4,4,4,4],36:Array(9).fill(4)};
for(const [n,expected] of Object.entries(EXPECTED))
  test(`calculatePoolSizes(${n}) matches required distribution`,()=>{
    assert.deepEqual(calculatePoolSizes(Number(n)),expected);
  });

for(const n of [6,7,10,11,13,18,22,25,31])
  test(`calculatePoolSizes(${n}) is balanced and valid without special-casing`,()=>{
    const sizes=calculatePoolSizes(n);
    assert.equal(sizes.reduce((a,b)=>a+b,0),n,'sizes must sum to total teams');
    assert.ok(sizes.every(s=>s>=MIN_POOL_SIZE&&s<=MAX_POOL_SIZE),'every pool within min/max');
    assert.ok(Math.max(...sizes)-Math.min(...sizes)<=1,'pool sizes differ by at most 1');
  });

test('pool naming goes A..Z then AA, AB...',()=>{
  const names=Array.from({length:30},(_,i)=>poolName(i));
  assert.deepEqual(names.slice(0,5),['A','B','C','D','E']);
  assert.equal(names[25],'Z');
  assert.equal(names[26],'AA');
  assert.equal(names[27],'AB');
});

test('assignPools: every participant appears exactly once, in exactly one pool',()=>{
  const parts=ids(17);
  const pools=assignPools(parts,calculatePoolSizes(17));
  assert.equal(pools.length,4);
  const allIds=pools.flatMap(p=>p.participants.map(x=>x.id));
  assert.equal(allIds.length,17);
  assert.equal(new Set(allIds).size,17);
});

test('per-pool round-robin: no duplicate pairings, no self-matches, correct match count per pool',()=>{
  const parts=ids(17);
  const pools=assignPools(parts,calculatePoolSizes(17));
  for(const pool of pools){
    const schedule=buildRoundRobinSchedule(pool.participants);
    const pairings=schedule.flat();
    const n=pool.participants.length;
    assert.equal(pairings.length,n*(n-1)/2,`pool ${pool.name} has n*(n-1)/2 matches`);
    const keys=pairings.map(x=>[x.participant1.id,x.participant2.id].sort().join('-'));
    assert.equal(new Set(keys).size,keys.length,'no duplicate pairings within a pool');
    assert.ok(pairings.every(x=>x.participant1.id!==x.participant2.id),'no self-matches');
    for(const round of schedule)assert.equal(new Set(round.flatMap(x=>[x.participant1.id,x.participant2.id])).size,round.length*2,'no participant plays twice in the same round');
  }
});

test('idempotency: calculatePoolSizes is deterministic for the same input',()=>{
  for(const n of [16,17,20,24,36,11,22])
    assert.deepEqual(calculatePoolSizes(n),calculatePoolSizes(n));
});

test('pool isolation: pools generated from disjoint participant sets never share a participant',()=>{
  const parts=ids(22);
  const pools=assignPools(parts,calculatePoolSizes(22));
  const seen=new Set();
  for(const pool of pools)for(const p of pool.participants){assert.ok(!seen.has(p.id));seen.add(p.id);}
});

const row=(id,points,pointDiff,pointsFor)=>({participantId:id,points,pointDiff,pointsFor});
test('selectQualifiers: takes qualifiersPerPool from every pool, never skips a pool',()=>{
  const poolStandings=[
    {poolId:'A',standings:[row('A1',6,10,50),row('A2',4,2,40),row('A3',2,-5,30)]},
    {poolId:'B',standings:[row('B1',6,8,45),row('B2',2,-8,20)]},
  ];
  const q=selectQualifiers(poolStandings,{qualifiersPerPool:1});
  assert.deepEqual(q.map(x=>x.participantId).sort(),['A1','B1']);
});
test('selectQualifiers: bestThirdPlaceCount picks next-best non-qualifiers across pools',()=>{
  const poolStandings=[
    {poolId:'A',standings:[row('A1',6,10,50),row('A2',4,5,40),row('A3',2,-5,30)]},
    {poolId:'B',standings:[row('B1',6,8,45),row('B2',4,1,35),row('B3',2,-9,20)]},
  ];
  const q=selectQualifiers(poolStandings,{qualifiersPerPool:1,bestThirdPlaceCount:1});
  assert.equal(q.length,3);
  assert.ok(q.some(x=>x.participantId==='A2'),'A2 (best runner-up, higher pointDiff) should be the wildcard-3rd pick');
});
test('selectQualifiers: wildcardCount fills remaining slots from the next best-ranked unqualified teams',()=>{
  const poolStandings=[{poolId:'A',standings:[row('A1',6,10,50),row('A2',4,5,40),row('A3',2,-5,30)]}];
  const q=selectQualifiers(poolStandings,{qualifiersPerPool:1,wildcardCount:2});
  assert.deepEqual(q.map(x=>x.participantId),['A1','A2','A3']);
});
test('selectQualifiers: targetBracketSize trims to exactly that many, keeping the best-ranked',()=>{
  const poolStandings=[
    {poolId:'A',standings:[row('A1',6,10,50),row('A2',4,5,40)]},
    {poolId:'B',standings:[row('B1',6,8,45),row('B2',4,1,35)]},
  ];
  const q=selectQualifiers(poolStandings,{qualifiersPerPool:2,targetBracketSize:3});
  assert.equal(q.length,3);
  assert.deepEqual(q.map(x=>x.participantId),['A1','B1','A2']);
});
test('selectQualifiers: no participant is selected twice even if eligible for multiple reasons',()=>{
  const poolStandings=[{poolId:'A',standings:[row('A1',6,10,50),row('A2',4,5,40),row('A3',2,-5,30)]}];
  const q=selectQualifiers(poolStandings,{qualifiersPerPool:1,bestThirdPlaceCount:5,wildcardCount:5});
  assert.equal(new Set(q.map(x=>x.participantId)).size,q.length);
});
