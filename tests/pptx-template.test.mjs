import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DOMParser } from '@xmldom/xmldom';
import JSZip from 'jszip';
import sharp from 'sharp';
import { openTemplate, saveTemplate } from '../lib/pptx-template.mjs';
import { generateDeck } from '../lib/generator.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const parse=xml=>new DOMParser().parseFromString(xml,'application/xml');
const nodes=(doc,name)=>Array.from(doc.getElementsByTagName(name));
const shapeText=shape=>nodes(shape,'a:p').map(p=>nodes(p,'a:t').map(t=>t.textContent).join('')).join('\n');
const findShape=(doc,name)=>nodes(doc,'p:sp').find(n=>nodes(n,'p:cNvPr')[0]?.getAttribute('name')===name);
const fmt=n=>n.toLocaleString('en-US');
const inspect=(p,no,kind='textbox')=>p.inspect({select:"$.slides["+(no-1)+"].elements[?(@.kind == '"+kind+"')]"});

test('template editing preserves mixed run typography, group coordinates, and slide order',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'osu-pptx-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const p=await openTemplate(path.join(root,'assets/template.pptx'));
  const original=p.slides.items[3];
  const records=(await inspect(p,4)).records;
  const record=records.find(r=>/^SCORE\s/.test(r.text));assert.ok(record);
  const target=p.resolve(record.id),runsBefore=nodes(target.node,'a:rPr').map(n=>n.getAttribute('sz'));
  const match=record.text.match(/\d[\d,]*/);target.text.getRange(match.index,match[0].length).replace('1,234,567');
  assert.match(target.text.value,/1,234,567/);
  assert.deepEqual(nodes(target.node,'a:rPr').map(n=>n.getAttribute('sz')),runsBefore);
  const before=target.frame;target.position.left+=15;assert.ok(Math.abs(target.frame.left-before.left-15)<0.001);
  target.bringToFront();assert.ok(Math.abs(target.frame.top-before.top)<0.001);
  const copy=original.duplicate();for(const slide of [...p.slides.items])if(slide!==copy)slide.delete();copy.moveTo(0);
  const out=path.join(dir,'edited.pptx');await saveTemplate(p,out);
  const result=await openTemplate(out);assert.equal(result.slides.items.length,1);
  const edited=(await inspect(result,1)).records.find(r=>r.text.includes('1,234,567'));
  assert.ok(edited);assert.ok(Math.abs(edited.position.left-before.left-15)<0.001);
});

function fixture(mode,cover){
  const count=mode==='OWC'?4:3,codes=mode==='OWC'?['NM1','HD1','HR1','DT1','FM1','NM2','HD2','HR2','DT2','FM2','NM3','HD3','TB']:['RC1','LN1','HB1','RC2','LN2','HB2','RC3','LN3','HB3','RC4','LN4','HB4','TB'];
  const games=codes.map((code,index)=>{
    const winner=index%2?'red':'blue';
    const scores=['red','blue'].flatMap(team=>Array.from({length:count},(_,rank)=>({name:'TEST_'+team+'_'+index+'_'+rank,team,score:900000+index*100+(team===winner?10000:0)+(count-rank)*1000,accuracy:0.985,maxCombo:321,statistics:{perfect:500,great:200,good:1,ok:2,meh:0,miss:0},mods:rank===0?['NF','HD','HR']:[]}))).reverse();
    const total=team=>scores.filter(s=>s.team===team).reduce((a,b)=>a+b.score,0);
    return {id:index+1,beatmapId:1000+index,poolMap:{code,beatmapId:1000+index},scores,redTotal:total('red'),blueTotal:total('blue'),winner,beatmap:{id:1000+index,version:'TEST Difficulty '+index,total_length:123+index,bpm:160+index,difficulty_rating:5+index/10,count_circles:321,count_sliders:0,max_combo:321,cs:4,ar:9,accuracy:8,beatmapset:{artist:'TEST Artist',title:'TEST Map '+index,creator:'TEST Mapper',covers:cover?{cover}:{}}}};
  });
  return {input:{tournamentType:mode,competitionName:'TEST Tournament',round:'Grand Finals',bracket:'Bracket Reset',bestOf:13,matchTime:'Sat, 31 Oct @08:00(UTC+0)',redTeam:'Test Red Country',blueTeam:'Test Blue Country',redSeed:'#11',blueSeed:'#22',redRoll:'win',blueRoll:'lose',redProtect:'RC7',blueProtect:'LN1',redBan:'RC8',blueBan:'LN4',redBan2:'HD2',blueBan2:'DT3',firstPicker:'red',stdFirstBan:'blue'},games,pool:games.map(g=>g.poolMap)};
}

for(const mode of ['MWC4k','OWC'])test(mode+' generates a complete 6–7 match with only public dependencies',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'osu-match-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const png=await sharp({create:{width:320,height:90,channels:3,background:'#123456'}}).png().toBuffer();
  const fixtureData=fixture(mode,'data:image/png;base64,'+png.toString('base64'));
  const source=path.join(root,'assets',mode==='OWC'?'template-std.pptx':'template.pptx'),before=await fs.readFile(source);
  const output=path.join(dir,'match.pptx'),progress=[];
  const result=await generateDeck({templatePath:source,outputPath:output,...fixtureData,onProgress:f=>progress.push(f)});
  const cycle=mode==='OWC'?7:6;assert.equal(result.slideCount,13*cycle+4);assert.equal(result.redWins,6);assert.equal(result.blueWins,7);assert.equal(progress.at(-1),1);
  assert.equal(createHash('sha256').update(await fs.readFile(source)).digest('hex'),createHash('sha256').update(before).digest('hex'));
  const zip=await JSZip.loadAsync(await fs.readFile(output));
  const mapInfoTexts=[];
  for(const file of Object.keys(zip.files).filter(n=>/^ppt\/slides\/slide\d+\.xml$/.test(n))){
    const doc=parse(await zip.file(file).async('string'));
    mapInfoTexts.push(...nodes(doc,'p:sp').map(shapeText));
  }
  assert.ok(mapInfoTexts.some(text=>/MAX COMBO/.test(text)),'Player MAX COMBO must remain');
  assert.equal(mapInfoTexts.some(text=>/\bCombos\b/.test(text)),mode==='MWC4k','Only OWC map Combos is omitted');
  for(let i=0;i<13;i++){
    const start=3+i*cycle;
    const pick=parse(await zip.file('ppt/slides/slide'+start+'.xml').async('string'));
    const code=findShape(pick,'!!MAP_CODE_LABEL_'+start);assert.ok(code,'Pick must have an editable code label for map '+i);assert.equal(shapeText(code),fixtureData.games[i].poolMap.code);
    assert.equal(nodes(pick,'p:pic').length,1,'Only Pick carries the map cover');
    const native=nodes(pick,'p:cNvPr').map(n=>n.getAttribute('name'));
    assert.ok(native.findIndex(n=>n.startsWith('!!MAP_BG_'))<native.indexOf('!!MAP_CODE_LABEL_'+start));
    const score=parse(await zip.file('ppt/slides/slide'+(start+1)+'.xml').async('string'));
    const texts=nodes(score,'p:sp').map(shapeText).join('\n');
    assert.ok(texts.includes('TEST_blue_'+i+'_0'));assert.ok(texts.includes('TEST_red_'+i+'_0'));
    assert.ok(texts.includes(fmt(fixtureData.games[i].redTotal)));assert.ok(texts.includes(fmt(fixtureData.games[i].blueTotal)));
    for(let j=1;j<cycle;j++){
      const doc=parse(await zip.file('ppt/slides/slide'+(start+j)+'.xml').async('string'));
      assert.ok(!nodes(doc,'p:cNvPr').some(n=>/!!MAP_(?:BG|CODE_LABEL)_/.test(n.getAttribute('name'))));
      assert.ok(findShape(doc,'!!PROGRESS_CODE_'+String(i+1).padStart(2,'0')),'Late-slide progress remains complete');
    }
    const pickFilled=nodes(pick,'p:sp').filter(s=>/^!!SCORE_/.test(nodes(s,'p:cNvPr')[0]?.getAttribute('name'))&&nodes(s,'a:srgbClr').some(n=>n.getAttribute('val')==='FFE9A6')).length;
    assert.equal(pickFilled,i,'Pick never includes the current map point');
    const scoreFilled=nodes(score,'p:sp').filter(s=>/^!!SCORE_/.test(nodes(s,'p:cNvPr')[0]?.getAttribute('name'))&&nodes(s,'a:srgbClr').some(n=>n.getAttribute('val')==='FFE9A6')).length;
    assert.equal(scoreFilled,i+1);
    const rail=findShape(score,'!!PROGRESS_CODE_'+String(i+1).padStart(2,'0'));assert.equal(shapeText(rail),fixtureData.games[i].poolMap.code);
    if(i===12)assert.ok(nodes(code,'a:srgbClr').some(n=>n.getAttribute('val')==='8C238C'));
  }
  for(const file of Object.keys(zip.files).filter(n=>n.endsWith('.rels'))){
    const doc=parse(await zip.file(file).async('string'));
    const base=path.posix.dirname(path.posix.dirname(file));
    for(const rel of nodes(doc,'Relationship')){
      if(rel.getAttribute('TargetMode')==='External')continue;
      const target=rel.getAttribute('Target');const resolved=target.startsWith('/')?target.slice(1):path.posix.normalize(path.posix.join(base,target));
      assert.ok(zip.file(resolved),'Missing relationship target: '+file+' → '+resolved);
    }
  }
  const final=parse(await zip.file('ppt/slides/slide'+(result.slideCount-1)+'.xml').async('string'));
  assert.ok(nodes(final,'p:sp').map(shapeText).join('\n').includes('6 - 7'));
  assert.ok(nodes(final,'p:sp').map(shapeText).join('\n').includes('Test Blue Country'));
});
