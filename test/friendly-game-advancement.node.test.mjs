import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFriendlyGameService, FriendlyGameError} from '../src/services/friendly-game.service.js';
import {FriendlyGameMemoryRepository} from './helpers/friendly-game-memory-repository.mjs';
import {createFriendlyGameBroadcaster} from './helpers/friendly-game-broadcaster.mjs';
import {createFriendlyTestState} from './helpers/friendly-test-state.mjs';

function setup(type='PLAYER', slot=1, conflict=null) {
  const state=createFriendlyTestState();
  state.matches.set('f',{id:'f',creator_player_id:'owner',status:'ACTIVE'});
  state.players.set('owner',{id:'owner',userId:'u-owner'});
  const source={id:'source',friendly_match_id:'f',status:'LIVE',participant1_id:type==='TEAM'?'team-a':'player-a',participant1_type:type,participant2_id:type==='TEAM'?'team-b':'player-b',participant2_type:type,participant1_score:21,participant2_score:19,winning_points:21,next_match_id:'downstream',next_match_slot:slot,updated_at:'after'};
  const downstream={id:'downstream',friendly_match_id:'f',status:'SCHEDULED',participant1_id:slot===1?conflict:null,participant1_type:slot===1&&conflict?type:null,participant2_id:slot===2?conflict:null,participant2_type:slot===2&&conflict?type:null,participant1_score:0,participant2_score:0};
  state.gameMatches.set('source',source); state.gameMatches.set('downstream',downstream);
  const repo=new FriendlyGameMemoryRepository({state}), broadcaster=createFriendlyGameBroadcaster();
  const transaction=async(_,fn)=>{const snapshot=new Map([...state.gameMatches].map(([id,row])=>[id,structuredClone(row)]));try{return await fn(repo);}catch(error){for(const [id,row] of snapshot)state.gameMatches.set(id,row);throw error;}};
  const service=createFriendlyGameService({repositoryFactory:()=>repo,withTransaction:transaction,broadcaster});
  return {state,repo,broadcaster,service,source,downstream,identity:{sub:'u-owner'}};
}

for (const [type,slot,winner] of [['PLAYER',1,'player-a'],['TEAM',2,'team-a']]) {
  test(`${type} winner advances to persisted slot ${slot} and downstream stays scheduled`,async()=>{
    const x=setup(type,slot);
    const result=await x.service.complete({},'f','source',x.identity);
    assert.equal(result.status,'COMPLETED');
    assert.equal(result.winner_id,winner); assert.equal(result.winner_type,type);
    assert.equal(x.downstream[`participant${slot}_id`],winner);
    assert.equal(x.downstream[`participant${slot}_type`],type);
    assert.equal(x.downstream.status,'SCHEDULED');
    assert.deepEqual([x.downstream.participant1_score,x.downstream.participant2_score],[0,0]);
    assert.equal(x.state.matches.get('f').status,'ACTIVE');
    assert.equal(x.broadcaster.events.length,1);
    const event=x.broadcaster.events[0];
    assert.equal(event.room,'friendly-match:source'); assert.equal(event.event.type,'MATCH_COMPLETED');
    assert.equal(event.event.winnerId,winner); assert.equal(event.event.winningPoints,21);
  });
}

test('same-winner completion retry is safe and does not corrupt the other slot',async()=>{
  const x=setup('PLAYER',1,'player-a');
  await x.service.complete({},'f','source',x.identity);
  assert.equal(x.downstream.participant1_id,'player-a'); assert.equal(x.downstream.participant2_id,null);
  const events=x.broadcaster.events.length;
  await x.service.complete({},'f','source',x.identity);
  assert.equal(x.downstream.participant1_id,'player-a'); assert.equal(x.downstream.participant2_id,null);
  assert.equal(x.broadcaster.events.length,events+1);
});

test('conflicting downstream occupant rolls back source and emits no completion event',async()=>{
  const x=setup('PLAYER',1,'other-player');
  await assert.rejects(()=>x.service.complete({},'f','source',x.identity),e=>e instanceof FriendlyGameError&&e.status===409);
  assert.equal(x.state.gameMatches.get('source').status,'LIVE'); assert.equal(x.state.gameMatches.get('source').winner_id,undefined);
  assert.equal(x.downstream.participant1_id,'other-player'); assert.equal(x.downstream.participant2_id,null);
  assert.deepEqual([x.downstream.participant1_score,x.downstream.participant2_score],[0,0]);
  assert.equal(x.broadcaster.events.length,0);
});

test('friendly completion room is isolated from another friendly game and official room naming',async()=>{
  const x=setup(); x.state.gameMatches.set('other',{id:'other',friendly_match_id:'f',status:'LIVE',participant1_id:'x',participant2_id:'y'});
  await x.service.complete({},'f','source',x.identity);
  assert.deepEqual([...new Set(x.broadcaster.events.map(e=>e.room))],['friendly-match:source']);
  assert.notEqual('friendly-match:source','match:source');
});
