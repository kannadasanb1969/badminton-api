import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isMatchCompletionEligible} from '../src/utils/match-scoring.js';

for (const [target,eligible,rejected] of [[15,[17,15],[16,15]],[21,[23,21],[22,21]],[30,[32,30],[31,30]]]) {
  test(`${target}-point games use target plus two-point lead`,()=>{
    assert.equal(isMatchCompletionEligible(...eligible,target),true);
    assert.equal(isMatchCompletionEligible(...rejected,target),false);
    assert.equal(isMatchCompletionEligible(target,target,target),false);
  });
}

test('scores may exceed 30 while the match remains live',()=>{
  assert.equal(isMatchCompletionEligible(31,30,21),false);
  assert.equal(isMatchCompletionEligible(32,30,21),true);
});

test('15-point completion accepts valid leads and rejects one-point leads',()=>{
  for (const [a,b] of [[15,4],[15,13],[16,14],[17,15],[18,16]]) {
    assert.equal(isMatchCompletionEligible(a,b,15),true,`${a}-${b} should complete`);
  }
  for (const [a,b] of [[15,14],[16,15]]) {
    assert.equal(isMatchCompletionEligible(a,b,15),false,`${a}-${b} should remain live`);
  }
});
