import test from 'node:test';
import assert from 'node:assert/strict';
import {applyStdModAttributes, mapDisplayMods} from '../lib/beatmap-mods.mjs';
import {extractGames, fetchModdedBeatmap} from '../lib/osu.mjs';

const base = {id:123,total_length:180,hit_length:150,bpm:180,cs:4,ar:9,accuracy:8,drain:6,difficulty_rating:5,max_combo:1000};
const attributes = {star_rating:7.123,max_combo:1000};
const near = (actual, expected) => assert.ok(Math.abs(actual-expected)<1e-8, `${actual} != ${expected}`);

test('DT shortens duration, increases BPM and converts AR/OD through timing windows', () => {
  const result=applyStdModAttributes(base,['DT'],attributes);
  assert.equal(result.total_length,120);assert.equal(result.hit_length,100);assert.equal(result.bpm,270);
  near(result.ar,10.333333333333334);near(result.accuracy,9.777777777777779);
  assert.equal(result.cs,4);assert.equal(result.difficulty_rating,7.123);
  assert.equal(base.total_length,180);assert.equal(base.difficulty_rating,5);
});

test('HR applies stat multipliers and caps before DT timing conversion', () => {
  const hr=applyStdModAttributes(base,['HR'],attributes);
  near(hr.cs,5.2);assert.equal(hr.ar,10);assert.equal(hr.accuracy,10);near(hr.drain,8.4);
  assert.equal(hr.bpm,180);assert.equal(hr.total_length,180);
  const combo=applyStdModAttributes(base,['HD','HR','DT'],attributes);
  near(combo.ar,11);near(combo.accuracy,11.11111111111111);near(combo.cs,5.2);
});

test('HD uses official modded stars without altering length or difficulty settings', () => {
  const result=applyStdModAttributes(base,['HD'],attributes);
  for(const key of ['cs','ar','accuracy','bpm','total_length','hit_length','drain']) assert.equal(result[key],base[key]);
  assert.equal(result.difficulty_rating,attributes.star_rating);
});

test('missing official combo count is unknown rather than a false zero', () => {
  assert.equal(applyStdModAttributes(base,['HR'],{star_rating:7,max_combo:0}).max_combo,1000);
  assert.equal(applyStdModAttributes({...base,max_combo:0},['HR'],{star_rating:7,max_combo:0}).max_combo,null);
});

test('pool required mods combine with room mods, FM does not combine individual player mods', () => {
  assert.deepEqual(mapDisplayMods({poolMap:{code:'DT3'},mods:['HD','NF']}),['DT','HD']);
  assert.deepEqual(mapDisplayMods({poolMap:{code:'HDHR1'},mods:[]}),['HD','HR']);
  assert.deepEqual(mapDisplayMods({poolMap:{code:'FM1'},scores:[{mods:['HR']},{mods:['HD']}]}),[]);
  const payload={events:[{game:{id:1,beatmap:base,mods:['DT'],scores:[]}}]};
  assert.deepEqual(extractGames(payload)[0].mods,['DT']);
});

test('attribute cache separates mod combinations and never mutates the no-mod cache', async () => {
  const originalFetch=globalThis.fetch;const requests=[];
  globalThis.fetch=async (url,options)=>{requests.push(JSON.parse(options.body));return new Response(JSON.stringify({attributes}),{status:200});};
  try {
    const cache=new Map();
    const dt=await fetchModdedBeatmap({beatmap:base,poolMap:{code:'DT1'}},'test',cache);
    await fetchModdedBeatmap({beatmap:base,poolMap:{code:'DT2'}},'test',cache);
    const hr=await fetchModdedBeatmap({beatmap:base,poolMap:{code:'HR1'}},'test',cache);
    assert.equal(requests.length,2);assert.equal(cache.size,2);assert.equal(dt.total_length,120);assert.equal(hr.total_length,180);
    assert.equal(base.total_length,180);assert.equal(base.cs,4);
  } finally {globalThis.fetch=originalFetch;}
});

test('attribute errors cannot silently fall back to unmodified stars', async () => {
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({message:'Unavailable'}),{status:503});
  try {await assert.rejects(fetchModdedBeatmap({beatmap:base,poolMap:{code:'DT1'}},'test'),/属性读取失败/);}
  finally {globalThis.fetch=originalFetch;}
});
