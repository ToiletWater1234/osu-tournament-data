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

test('manual edits can replace a missing map and keep all chosen rounds in order', () => {
  const pool = [{beatmapId:1,code:'NM1'}, {beatmapId:2,code:'TB'}];
  const scores = [{name:'Red',team:'red',score:250},{name:'Blue',team:'blue',score:200}];
  const input = {modeLabel:'osu!',playersPerTeam:4};
  const edits = validateEditedGames([{beatmapId:2,scores}, {beatmapId:1,scores}],pool,input);
  assert.deepEqual(edits.map(game => game.poolMap.code), ['TB','NM1']);
  assert.equal(prepareSeries(edits, 1).games.length, 1);
  assert.equal(prepareSeries(edits, 1, {manual:true}).games.length, 2);
  assert.throws(() => validateEditedGames([{beatmapId:3,scores}],pool,input), /图池/);
  assert.throws(() => validateEditedGames([{beatmapId:2,scores:[{...scores[0],accuracyMode:'direct',manualAccuracy:'101'}]}],pool,input), /ACC/);
});
