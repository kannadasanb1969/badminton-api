import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('Friendly cleanup FK contract is non-blocking',async()=>{const source=await readFile(new URL('../migrations/20260913_friendly_match_domain.sql',import.meta.url),'utf8');for(const col of ['source_match_1_id','source_match_2_id','next_match_id'])assert.match(source,new RegExp(`${col}[^\\n]*ON DELETE SET NULL`));assert.match(source,/match_id text NOT NULL REFERENCES friendly_game_matches\(id\) ON DELETE CASCADE/);});
