import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildKnockoutBracket} from '../src/utils/friendly-fixtures.js';

// fixture.service.js's tournament KNOCKOUT generation now builds its bracket with this same function
// (previously it only persisted a single flat round for non-power-of-two counts with no round-2+ progression).
// This test verifies the algorithm itself across the exact participant-count matrix from the migration spec.

function participants(n) { return Array.from({length: n}, (_, i) => ({id: `p${i + 1}`, type: 'PLAYER', name: `P${i + 1}`})); }

for (const n of [4, 5, 6, 7, 8, 9, 10, 11, 16]) {
  test(`KNOCKOUT bracket for ${n} participants: full round progression, correct BYE handling, no duplicates`, () => {
    const parts = participants(n);
    const bracket = buildKnockoutBracket(parts);

    // Bracket size is the next power of two ≥ n.
    let expectedSize = 1; while (expectedSize < n) expectedSize *= 2;
    assert.equal(bracket.bracketSize, expectedSize);
    assert.equal(bracket.byeCount, expectedSize - n);

    // Every participant appears exactly once across round-1 slots (no duplicate, none missing).
    const round1 = bracket.rounds[0];
    const seenIds = round1.flatMap(m => [m.participant1, m.participant2]).filter(Boolean).map(p => p.id);
    assert.deepEqual([...seenIds].sort(), parts.map(p => p.id).sort());
    assert.equal(new Set(seenIds).size, seenIds.length, 'no participant appears twice in round 1');

    // No self-match: a match never has the same participant on both sides.
    for (const m of bracket.matches) {
      if (m.participant1 && m.participant2) assert.notEqual(m.participant1.id, m.participant2.id);
    }

    // Full bracket progression exists beyond round 1 whenever there's more than one round-1 match.
    const totalRounds = Math.log2(expectedSize);
    assert.equal(bracket.rounds.length, totalRounds);

    // Every non-final match links to a next match/slot; the final match links to none.
    const finalRound = bracket.rounds[bracket.rounds.length - 1];
    assert.equal(finalRound.length, 1, 'exactly one final match');
    for (const m of bracket.matches) {
      if (bracket.rounds[bracket.rounds.length - 1].includes(m)) { assert.equal(m.next, null); continue; }
      assert.ok(m.next, `non-final match ${m.key} must link to a next match`);
      assert.ok(m.nextSlot === 1 || m.nextSlot === 2);
    }

    // A round-1 bye (one real participant, no opponent) auto-advances that participant directly into round 2's slot.
    for (const m of round1) {
      if (m.byeParticipant) {
        const downstream = bracket.matches.find(x => x.key === m.next);
        assert.ok(downstream, 'bye match must link to a round-2 match');
        const landedInSlot1 = downstream.participant1?.id === m.byeParticipant.id;
        const landedInSlot2 = downstream.participant2?.id === m.byeParticipant.id;
        assert.ok(landedInSlot1 || landedInSlot2, `bye winner ${m.byeParticipant.id} must be pre-seeded into round 2`);
      }
    }

    // Match count sanity: size-1 total matches in a single-elimination bracket of `size` slots.
    assert.equal(bracket.matches.length, expectedSize - 1);
  });
}
