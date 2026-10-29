import test from 'node:test';
import assert from 'node:assert/strict';
import {loserTeamAverage,relativeScoreIndex} from '../lib/rsi.mjs';
import {tournaments,normalizeTournamentInput,resolveTournament,requireTournamentTemplate} from '../public/tournaments.js';
const game=(red,blue)=>({scores:[...red.map(score=>({team:'red',score})),...blue.map(score=>({team:'blue',score}))]});
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-10,`${a} != ${b}`);

test('winning and losing players share the losing-team mean and exponent 1.5',()=>{
  const average=loserTeamAverage(game([100,100,100,100],[110,70,70,70]),4);
  assert.equal(average,80);
  near(relativeScoreIndex(100,average),1.25**1.5);
  near(relativeScoreIndex(110,average),1.375**1.5);
  assert.ok(relativeScoreIndex(110,average)>relativeScoreIndex(100,average));
});
test('swapping team colours does not change the common baseline',()=>{
  assert.equal(loserTeamAverage(game([110,70,70,70],[100,100,100,100]),4),80);
});
test('fixed 3v3 and 2v2 denominators use the corresponding match format',()=>{
  assert.equal(loserTeamAverage(game([100,100,100],[90,60,60]),3),70);
  assert.equal(loserTeamAverage(game([100,100],[90,50]),2),70);
});
test('missing participants, missing scores, ties and zero baselines stay unknown',()=>{
  for(const match of [game([100,100,100],[90,60,60]),game([100,100,100,100],[90,60,60,null]),game([100,100],[100,100]),game([100,100],[0,0])])assert.equal(loserTeamAverage(match,match.scores.length===4?2:4),null);
  assert.equal(relativeScoreIndex(null,80),null);assert.equal(relativeScoreIndex(100,null),null);
  assert.equal(relativeScoreIndex(0,80),0);
});
test('five named tournament formats fix the server-side player counts',()=>{
  assert.deepEqual(tournaments.map(x=>[x.id,x.playersPerTeam]),[['OWC',4],['CWC',3],['TWC',2],['MWC4k',3],['MWC7k',2]]);
  assert.equal(normalizeTournamentInput({tournamentType:'OWC',playersPerTeam:2}).playersPerTeam,4);
  assert.equal(normalizeTournamentInput({tournamentType:'MWC4k',playersPerTeam:4}).playersPerTeam,3);
  assert.equal(resolveTournament('osu!mania','osu!mania 7K World Cup').id,'MWC7k');
  assert.equal(resolveTournament('osu!mania').id,'MWC4k');
  assert.equal(resolveTournament('osu!').id,'OWC');
  assert.throws(()=>requireTournamentTemplate({tournamentType:'MWC7k'}),/专用赛制模板/);
});
