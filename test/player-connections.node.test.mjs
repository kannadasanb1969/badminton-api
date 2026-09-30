import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relationshipState } from '../src/services/player-connection.service.js';

test('connection states distinguish requested, incoming, connected, and none', () => {
  assert.equal(relationshipState('A', null), 'NONE');
  assert.equal(relationshipState('A', { status: 'PENDING', requester_player_id: 'A' }), 'REQUESTED');
  assert.equal(relationshipState('A', { status: 'PENDING', requester_player_id: 'B' }), 'INCOMING');
  assert.equal(relationshipState('A', { status: 'ACCEPTED', requester_player_id: 'B' }), 'CONNECTED');
  assert.equal(relationshipState('A', { status: 'DECLINED', requester_player_id: 'B' }), 'NONE');
});
