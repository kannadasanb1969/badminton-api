import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildKnockoutBracket,buildLeaguePairings,nextPowerOfTwo} from '../src/utils/friendly-fixtures.js';

const ids=n=>Array.from({length:n},(_,i)=>`P${i+1}`);
for(const [n,total] of [[6,7],[7,7],[8,7],[16,15]])test(`singles knockout ${n}`,()=>{const b=buildKnockoutBracket(ids(n));assert.equal(b.bracketSize,nextPowerOfTwo(n));assert.equal(b.matches.length,total);assert.equal(b.byeCount,b.bracketSize-n);assert.ok(b.matches.every(m=>m.participant1!==undefined&&m.participant2!==undefined));assert.ok(b.matches.filter(m=>m.next).every(m=>m.nextSlot===1||m.nextSlot===2));assert.equal(new Set(b.matches.flatMap(m=>[m.participant1,m.participant2]).filter(Boolean)).size,n);});
for(const n of [4,5,6,7,8])test(`doubles knockout ${n} teams`,()=>{const b=buildKnockoutBracket(ids(n).map(id=>`T${id}`));assert.equal(b.matches.length,nextPowerOfTwo(n)-1);assert.equal(b.byeCount,nextPowerOfTwo(n)-n);});
for(const n of [6,8])test(`singles league ${n}`,()=>{const p=buildLeaguePairings(ids(n));assert.equal(p.length,n*(n-1)/2);assert.equal(new Set(p.map(x=>[x.participant1,x.participant2].sort().join('-'))).size,p.length);});
for(const n of [4,8])test(`doubles league ${n}`,()=>assert.equal(buildLeaguePairings(ids(n).map(x=>`T${x}`)).length,n*(n-1)/2));
test('no fake BYE identity is created',()=>{const b=buildKnockoutBracket(ids(6));assert.ok(b.matches.some(m=>m.byeParticipant));assert.ok(b.matches.flatMap(m=>[m.participant1,m.participant2]).every(x=>x===null||/^P\d+$/.test(x)));});
