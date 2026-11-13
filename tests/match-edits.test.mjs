import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateAccuracy, formatAccuracy, prepareSeries } from '../public/match-data.js';
import { validateEditedGames } from '../lib/match-edits.mjs';

test('legacy judgment weights and percentage rounding match mplink', () => {
  const row = {statistics:{count_geki:1,count_300:1,count_katu:1,count_100:1,count_50:1,count_miss:1}};
  assert.equal(formatAccuracy(calculateAccuracy(row, 'osu!', 'scorev2')), '37.50%');
  assert.equal(formatAccuracy(calculateAccuracy(row, 'osu!mania', 'score')), '52.78%');
  assert.equal(formatAccuracy(calculateAccuracy(row, 'osu!mania', 'scorev2')), '52.19%');
  assert.equal(formatAccuracy(0.98755), '98.76%');
  assert.equal(calculateAccuracy({statistics:{}}, 'osu!'), null);
});

test('manual edits validate only the rounds needed to reach the deciding result', () => {
  const pool = [{beatmapId:1,code:'NM1'}, {beatmapId:2,code:'TB'}];
  const scores = [{name:'Red',team:'red',score:250},{name:'Blue',team:'blue',score:200}];
  const input = {modeLabel:'osu!',playersPerTeam:4};
  const rounds = [{beatmapId:2,scores}, {beatmapId:1,scores}, {beatmapId:3,scores}];
  const series = prepareSeries(validateEditedGames(rounds, pool, input), 3);
  assert.deepEqual(series.games.map(game => game.poolMap.code), ['TB','NM1']);
  assert.equal(series.redWins, 2);
  assert.throws(() => [...validateEditedGames([{beatmapId:3,scores}],pool,input)], /图池/);
  assert.throws(() => [...validateEditedGames([{beatmapId:2,scores:[{...scores[0],accuracyMode:'direct',manualAccuracy:'101'}]}],pool,input)], /ACC/);
});

test('score corrections can move the deciding round past the original finish', () => {
  const rounds = Array.from({length:8}, (_, i) => ({
    id: i + 1,
    scores: [{team:'red',score:i < 4 ? 100 : 200},{team:'blue',score:150}],
  }));
  const original = prepareSeries(rounds, 7);
  assert.equal(original.games.at(-1).id, 4);
  assert.equal(original.blueWins, 4);
  rounds[0].scores[0].score = 200;
  rounds[1].scores[0].score = 150;
  const corrected = prepareSeries(rounds, 7);
  assert.equal(corrected.games.at(-1).id, 7);
  assert.equal(corrected.redWins, 4);
  assert.equal(corrected.blueWins, 2);
  assert.equal(rounds.length, 8);
});

test('a tied round can extend a best-of series beyond its nominal round count', () => {
  const draw = { scores: [{team:'red',score:100},{team:'blue',score:100}] };
  const red = { scores: [{team:'red',score:200},{team:'blue',score:100}] };
  const blue = { scores: [{team:'red',score:100},{team:'blue',score:200}] };
  const series = prepareSeries([draw, red, blue, red], 3);
  assert.equal(series.games.length, 4);
  assert.equal(series.complete, true);
  assert.equal(series.redWins, 2);
});
