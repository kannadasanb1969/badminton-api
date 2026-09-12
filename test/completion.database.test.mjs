import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from 'pg';
import {completedKnockoutFinals,completedResultSummaries,withCompletion} from '../src/repositories/completion.repository.js';

test('PostgreSQL completion: early rounds, unfinished matches, unique final, bulk names and guest teams', {skip:!process.env.TEST_DATABASE_URL}, async()=>{
  const db=new Client({connectionString:process.env.TEST_DATABASE_URL});
  await db.connect();
  try {
    await db.query('CREATE TEMP TABLE matches (LIKE public.matches INCLUDING ALL)');
    await db.query('CREATE TEMP TABLE results (LIKE public.results INCLUDING ALL)');
    await db.query('CREATE TEMP TABLE fixtures (id text,status text,format text)');
    await db.query('CREATE TEMP TABLE player_profiles (id text,full_name text,player_code text)');
    await db.query('CREATE TEMP TABLE guest_players (id text,full_name text)');
    await db.query('CREATE TEMP TABLE teams (id text,team_code text,player1_id text,player1_type text,player2_id text,player2_type text)');
    await db.query("INSERT INTO fixtures VALUES ('f','PUBLISHED','KNOCKOUT')");
    await db.query("INSERT INTO player_profiles VALUES ('a','Winner','PLR1'),('b','Runner Up','PLR2')");
    await db.query("INSERT INTO guest_players VALUES ('g','Guest Partner')");
    await db.query("INSERT INTO teams VALUES ('ta','TEM1','a','FULL','g','GUEST'),('tb','TEM2','a','FULL','b','FULL')");
    let matchNumber=0;
    const insert=async(id,round,status,next=null)=>db.query("INSERT INTO matches(id,match_code,fixture_id,tournament_id,category_id,round_number,participant1_id,participant2_id,participant1_type,participant2_type,status,winner_id,participant1_score,participant2_score,completed_at,next_match_id,match_number) VALUES ($1::text,$1::varchar,'f','t','c',$2,'a','b','PLAYER','PLAYER',$3::varchar,CASE WHEN $3::varchar='COMPLETED' THEN 'a' END,21,3,CASE WHEN $3::varchar='COMPLETED' THEN NOW() END,$4,$5)",[id,round,status,next,++matchNumber]);
    await insert('semi1',1,'COMPLETED','final');await insert('semi2',1,'SCHEDULED','final');await insert('final',2,'SCHEDULED');
    assert.equal((await completedKnockoutFinals(db,['t'])).length,0);
    await db.query("UPDATE matches SET status='COMPLETED',winner_id='a',completed_at=NOW() WHERE id='final'");
    assert.equal((await completedKnockoutFinals(db,['t'])).length,0,'pending sibling prevents completion');
    await db.query("UPDATE matches SET status='COMPLETED',winner_id='a',completed_at=NOW() WHERE id='semi2'");
    assert.equal((await completedKnockoutFinals(db,['t']))[0].id,'final');
    assert.equal((await completedResultSummaries(db,['t'])).size,0,'missing result is not completed');
    await db.query("INSERT INTO results(id,tournament_id,category_id,event_type,winner_participant_id,winner_participant_type,runner_up_participant_id,runner_up_participant_type,completed_at) VALUES ('r','t','c','SINGLES','a','PLAYER','b','PLAYER',NOW())");
    let summaries=await completedResultSummaries(db,['t']);
    assert.equal(summaries.get('c').winnerParticipantName,'Winner');assert.equal(summaries.get('c').runnerUpParticipantName,'Runner Up');
    const tournament={id:'t',name:'Test',categories:[{id:'c',name:'Singles'}]};
    assert.equal(withCompletion(tournament,summaries).completionStatus,'COMPLETED');
    assert.equal(withCompletion({...tournament,categories:[...tournament.categories,{id:'pending'}]},summaries).completionStatus,'IN_PROGRESS');
    await insert('ambiguous',2,'COMPLETED');assert.equal((await completedKnockoutFinals(db,['t'])).length,0);await db.query("DELETE FROM matches WHERE id='ambiguous'");
    await db.query("UPDATE fixtures SET status='DRAFT'");assert.equal((await completedKnockoutFinals(db,['t'])).length,0);await db.query("UPDATE fixtures SET status='PUBLISHED'");
    await db.query("UPDATE results SET winner_participant_id='b',runner_up_participant_id='a'");assert.equal((await completedResultSummaries(db,['t'])).size,0);
    await db.query("UPDATE matches SET participant1_id='ta',participant2_id='tb',participant1_type='TEAM',participant2_type='TEAM',winner_id='ta'");
    await db.query("UPDATE results SET event_type='DOUBLES',winner_participant_id='ta',runner_up_participant_id='tb',winner_participant_type='TEAM',runner_up_participant_type='TEAM'");
    summaries=await completedResultSummaries(db,['t']);assert.equal(summaries.get('c').winnerParticipantName,'Winner / Guest Partner');assert.equal(summaries.get('c').runnerUpParticipantName,'Winner / Runner Up');
    await db.query("DELETE FROM matches WHERE id<>'final'");assert.equal((await completedKnockoutFinals(db,['t'])).length,1,'single-match tournament completes');
  } finally {await db.end();}
});
