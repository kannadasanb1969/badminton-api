import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { bracketSizeFor, createKnockoutPlan } from '../src/services/knockout-plan.js';

describe('generic knockout planning', () => {
  for (const [count, size, byes, firstMatches] of [[2,2,0,1],[3,4,1,1],[5,8,3,1],[6,8,2,2],[8,8,0,4],[10,16,6,2],[16,16,0,8]]) {
    test(`plans ${count} participants`, () => {
      const participants = Array.from({ length: count }, (_, i) => `P${i + 1}`); const plan = createKnockoutPlan(participants);
      assert.equal(bracketSizeFor(count), size); assert.equal(plan.bracketSize, size); assert.equal(plan.byeCount, byes); assert.equal(plan.firstMatchCount, firstMatches);
      assert.equal(plan.matches.filter(x => x.round === 1).length, firstMatches);
      assert.equal(new Set(plan.matches.flatMap(x => x.participants.filter(Boolean))).size, count);
      assert.equal(plan.matches.filter(x => x.round === 2).length, size >= 4 ? size / 4 : 0);
    });
  }
  test('10 participants produce two real matches and an eight-slot next stage', () => {
    const plan = createKnockoutPlan(Array.from({ length: 10 }, (_, i) => `P${i}`));
    assert.equal(plan.matches.filter(x => x.round === 1).length, 2);
    assert.equal(plan.matches.filter(x => x.round === 2).length, 4);
    assert.equal(plan.matches.filter(x => x.round === 2).flatMap(x => x.participants.filter(Boolean)).length, 6);
  });
});
