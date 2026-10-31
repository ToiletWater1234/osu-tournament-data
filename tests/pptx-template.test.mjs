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
const direct=(node,name)=>Array.from(node?.childNodes || []).find(n=>n.nodeName===name);
function fontCharacters(shape){
  const body=direct(shape,'p:txBody'),list=direct(body,'a:lstStyle');
  const listDefault=nodes(list || shape,'a:defRPr')[0];
  const result=[];
  const paragraphs=Array.from(body?.childNodes || []).filter(n=>n.nodeName==='a:p');
  paragraphs.forEach((paragraph,index)=>{
    const defaults=direct(direct(paragraph,'a:pPr'),'a:defRPr');
    const attr=(props,key,fallback)=>props?.hasAttribute(key)?props.getAttribute(key):defaults?.hasAttribute(key)?defaults.getAttribute(key):listDefault?.hasAttribute(key)?listDefault.getAttribute(key):fallback;
    for(const run of Array.from(paragraph.childNodes).filter(n=>n.nodeName==='a:r')){
      const props=direct(run,'a:rPr'),family=direct(props,'a:latin')?.getAttribute('typeface') || direct(defaults,'a:latin')?.getAttribute('typeface') || 'Torus';
      const font={family,size:Number(attr(props,'sz',1800)),bold:attr(props,'b','0')==='1',italic:attr(props,'i','0')==='1'};
      for(const ch of (direct(run,'a:t')?.textContent || '').split(''))result.push({ch,font});
    }
    if(index<paragraphs.length-1)result.push({ch:'\n',font:null});
  });
  return result;
}
function fontAt(shape,pattern){
  const chars=fontCharacters(shape),text=chars.map(c=>c.ch).join(''),match=text.match(pattern);
  assert.ok(match,'Font sample not found: '+pattern+' in '+text);
  return chars[match.index].font;
}
function checkTemplateFonts(source,output,mode){
  const sourceShapes=nodes(source,'p:sp'),outputs=nodes(output,'p:sp'),byId=new Map(outputs.map(shape=>[nodes(shape,'p:cNvPr')[0]?.getAttribute('id'),shape]));
  let compared=0;
  for(const shape of sourceShapes){
    const next=byId.get(nodes(shape,'p:cNvPr')[0]?.getAttribute('id'));if(!next)continue;
    const before=fontCharacters(shape).filter(c=>c.ch.trim()),after=fontCharacters(next).filter(c=>c.ch.trim());if(!before.length||!after.length)continue;
    const fingerprints=[...new Set(before.map(c=>JSON.stringify(c.font)))];
    if(fingerprints.length===1){assert.deepEqual([...new Set(after.map(c=>JSON.stringify(c.font)))],fingerprints,'Uniform template font changed: '+shapeText(shape));compared++;}
    else if(shapeText(shape)===shapeText(next)){assert.deepEqual(after.map(c=>c.font),before.map(c=>c.font),'Mixed template font changed: '+shapeText(shape));compared++;}
    const text=shapeText(shape);
    for(const label of ['SCORE','ACCURACY','MAX COMBO','LENGTH','BPM','STAR RATING','CS','AR','OD']){
      const labelPattern=new RegExp('\\b'+label+'\\b');
      if(!labelPattern.test(text)||!labelPattern.test(shapeText(next)))continue;
      assert.deepEqual(fontAt(next,labelPattern),fontAt(shape,labelPattern),'Label typography changed: '+label);
      // All metric values following these labels must keep the template's
      // separate Torus Bold run and point size.
      if(label!=='BPM'){
        const sourceMatch=text.match(new RegExp('\\b'+label+'\\s+([\\d,?.%]+)'));
        const nextMatch=shapeText(next).match(new RegExp('\\b'+label+'\\s+([\\d,?.%]+)'));
        if(sourceMatch&&nextMatch){
          const from=fontCharacters(shape)[sourceMatch.index+sourceMatch[0].length-sourceMatch[1].length].font;
          const to=fontCharacters(next)[nextMatch.index+nextMatch[0].length-nextMatch[1].length].font;
          assert.deepEqual(to,from,'Value typography changed: '+label);compared++;
        }
      }
    }
    if(/\nBy /.test(text)){
      const mapper=mode==='MWC4k'?findShape(output,'!!MAP_MAPPER'):next;
      if(mapper)assert.deepEqual(fontAt(mapper,/By /),fontAt(shape,/By /),'Mapper must keep Torus Bold 11 pt without synthetic bold');
    }
  }
  return compared;
}

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
  // The source has latin + cs but no ea in some runs. Adding the font must
  // insert ea before cs, otherwise Microsoft PowerPoint repairs the file.
  target.text.typeface='Torus';
  for(const props of nodes(target.node,'a:rPr')){
    const fonts=Array.from(props.childNodes).filter(n=>['a:latin','a:ea','a:cs'].includes(n.nodeName)).map(n=>n.nodeName);
    assert.deepEqual(fonts,['a:latin','a:ea','a:cs']);
  }
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
  const template=await JSZip.loadAsync(before);
  const tagOwners=new Set();let fontChecks=0;
  for(let no=1;no<=result.slideCount;no++){
    const sourceNo=mode==='OWC'?(no===1?2:no===2?3:no>=result.slideCount-1?11:4+(no-3)%7):(no<=2?no:no===result.slideCount-1?45:no===result.slideCount?46:3+(no-3)%6);
    const doc=parse(await zip.file('ppt/slides/slide'+no+'.xml').async('string'));
    const sourceDoc=parse(await template.file('ppt/slides/slide'+sourceNo+'.xml').async('string'));
    fontChecks+=checkTemplateFonts(sourceDoc,doc,mode);
    const rels=parse(await zip.file('ppt/slides/_rels/slide'+no+'.xml.rels').async('string'));
    for(const rel of nodes(rels,'Relationship').filter(n=>n.getAttribute('Type').endsWith('/tags'))){
      const target=rel.getAttribute('Target');assert.ok(!tagOwners.has(target),'PowerPoint tag part is shared between duplicated slides: '+target);tagOwners.add(target);
    }
  }
  assert.ok(fontChecks>1000,'Every generated cycle must be checked against template typography');
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
    if(mode==='OWC')for(const doc of [pick,score]){
      for(const [team,fields] of [['RED',['redBan','redBan2']],['BLUE',['blueBan','blueBan2']]])fields.forEach((field,index)=>assert.equal(shapeText(findShape(doc,`!!BP_${team}_BAN_${index+1}`)),fixtureData.input[field]));
    }
    const texts=nodes(score,'p:sp').map(shapeText).join('\n');
    assert.ok(texts.includes('TEST_blue_'+i+'_0'));assert.ok(texts.includes('TEST_red_'+i+'_0'));
    assert.ok(texts.includes(fmt(fixtureData.games[i].redTotal)));assert.ok(texts.includes(fmt(fixtureData.games[i].blueTotal)));
    for(let j=1;j<cycle;j++){
      const doc=parse(await zip.file('ppt/slides/slide'+(start+j)+'.xml').async('string'));
      assert.ok(!nodes(doc,'p:cNvPr').some(n=>/!!MAP_(?:BG|CODE_LABEL)_/.test(n.getAttribute('name'))));
      assert.ok(findShape(doc,'!!PROGRESS_CODE_'+String(i+1).padStart(2,'0')),'Late-slide progress remains complete');
      if(mode==='OWC'){
        const delta=findShape(doc,'!!CENTRAL_DELTA');assert.ok(delta,'Every score/detail/RSI page must have the winner delta');
        assert.equal(shapeText(delta),'+'+fmt(Math.abs(fixtureData.games[i].redTotal-fixtureData.games[i].blueTotal)));
        const frame=direct(direct(delta,'p:spPr'),'a:xfrm'),offset=direct(frame,'a:off'),extent=direct(frame,'a:ext');
        const center=(Number(offset.getAttribute('x'))+Number(extent.getAttribute('cx'))/2)/9525;
        const redWon=fixtureData.games[i].redTotal>fixtureData.games[i].blueTotal;
        assert.equal(center<636.99,redWon,'Central delta must be above the winning team, independently of the picker');
        assert.equal(direct(nodes(delta,'a:p')[0],'a:pPr').getAttribute('algn'),redWon?'l':'r');
      }
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

test('OWC BO9 renders exactly one ban per team and keeps the complete rail fixed and centered',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'osu-bo9-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const fixtureData=fixture('OWC');fixtureData.games=fixtureData.games.slice(0,9);fixtureData.pool=fixtureData.games.map(g=>g.poolMap);
  Object.assign(fixtureData.input,{bestOf:9,round:'Group Stage',redBan:'DT1',blueBan:'DT3',redBan2:'STALE_RED_BAN',blueBan2:'STALE_BLUE_BAN'});
  const output=path.join(dir,'bo9.pptx');
  const result=await generateDeck({templatePath:path.join(root,'assets/template-std.pptx'),outputPath:output,...fixtureData});
  assert.equal(result.slideCount,67);assert.equal(result.redWins,4);assert.equal(result.blueWins,5);
  const p=await openTemplate(output);let fixedRollLeft;
  for(let no=3;no<=65;no++){
    const {records}=await inspect(p,no);
    const bans=records.filter(r=>/^!!BP_(RED|BLUE)_BAN_/.test(r.name));
    assert.equal(bans.length,2,'Only two ban cells, including on late result/detail slides');
    const red=bans.find(r=>r.name==='!!BP_RED_BAN_1'),blue=bans.find(r=>r.name==='!!BP_BLUE_BAN_1'),label=records.find(r=>r.name==='!!BP_BAN_LABEL');
    assert.equal(red.text,'DT1');assert.equal(blue.text,'DT3');
    assert.ok(Math.abs(label.position.width-96.36084)<.01,'Ban width matches the supplied BO9 sample');
    assert.ok(Math.abs(red.position.left-label.position.left)<.01);
    assert.ok(Math.abs(blue.position.left+blue.position.width-label.position.left-label.position.width)<.01);
    assert.ok(!records.some(r=>/STALE_(RED|BLUE)_BAN/.test(r.text)),'Hidden second-ban inputs cannot leak into the PPT');
    const roll=records.find(r=>r.text==='Roll');
    fixedRollLeft??=roll.position.left;assert.ok(Math.abs(roll.position.left-fixedRollLeft)<.01,'Progress rail never moves between pages');
    const codes=records.filter(r=>/^!!PROGRESS_CODE_/.test(r.name)).sort((a,b)=>a.position.left-b.position.left);
    if(codes.length===9){const end=codes.at(-1).position;assert.ok(Math.abs((roll.position.left+end.left+end.width)/2-640)<.01,'Center uses the final rail extent');}
  }
});
