import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('friendly score-history repository writes only migration-backed compatible columns',async()=>{
  const repo=await readFile(new URL('../src/repositories/friendly-game.repository.js',import.meta.url),'utf8');
  const migration=await readFile(new URL('../migrations/20260913_friendly_match_domain.sql',import.meta.url),'utf8');
  const columns=['match_id','participant1_score','participant2_score','action','actor_player_id'];
  assert.match(repo,/INSERT INTO friendly_match_score_history/);
  for(const column of columns)assert.match(repo,new RegExp(`\\b${column}\\b`));
  assert.match(migration,/CREATE TABLE IF NOT EXISTS friendly_match_score_history/);
  for(const column of columns)assert.match(migration,new RegExp(`\\b${column}\\b`));
  assert.match(migration,/match_id text NOT NULL REFERENCES friendly_game_matches\(id\)/);
  assert.match(migration,/actor_player_id text REFERENCES player_profiles\(id\)/);
});
