import fs from 'node:fs/promises';
import path from 'node:path';
import { openTemplate, saveTemplate } from './pptx-template.mjs';
import JSZip from 'jszip';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { fetchWithRetry } from './network.mjs';
import { loserTeamAverage, relativeScoreIndex } from './rsi.mjs';
import { normalizeTournamentInput, requireTournamentTemplate, owcBanCount } from '../public/tournaments.js';

const q = value => value === undefined || value === null || value === '' ? '?' : String(value);
const fmt = value => value === undefined || value === null ? '?' : Number(value).toLocaleString('en-US');
const coverCache = new Map();
const fontWidthCache = new Map();
const sum = arr => arr.reduce((n, x) => n + (Number(x.score) || 0), 0);
const teamTotal = (game, team) => sum((game?.scores || []).filter(score => score.team === team));
// Exact solid colors sampled from the supplied template (not the brighter
// Office theme defaults previously used by generated shapes).
const RED = '#AB1415';
const BLUE = '#0F62A8';
const TB = '#8C238C';
const SLIDE_BG = '#38373C';
// Layout geometry uses CSS pixels (1 px = 0.75 pt); design sizes are PPT points.
const fontPt = points => points * 4 / 3;
const moduleRoot = path.dirname(fileURLToPath(import.meta.url));
const modAssetDir = path.join(moduleRoot, '..', 'assets', 'mods');

export function clearGeneratorCache() { coverCache.clear(); fontWidthCache.clear(); }

async function textWidth(text, target) {
  const family=target.typeface,points=target.fontSize*0.75,key=JSON.stringify([text,family,points]);
  if(fontWidthCache.has(key))return fontWidthCache.get(key);
  try{
    const escaped=String(text).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const fontfile=path.join(moduleRoot,'..','assets',/bold/i.test(family)?'TORUS-BOLD.OTF':'TORUS-REGULAR.OTF');
    const measured=await sharp({text:{text:escaped,font:`${family} ${points}`,fontfile,dpi:96,rgba:true}}).metadata();
    const width=Number(measured.width);if(width>0){fontWidthCache.set(key,width);return width;}
  }catch{}
  return [...String(text)].reduce((width,ch)=>width+(ch.charCodeAt(0)>255?1:0.58)*target.fontSize,0);
}

function slideList(presentation) { return [...presentation.slides.items]; }

export async function restoreSampleTransitions(pptxPath, teamNames = []) {
  const zip = await JSZip.loadAsync(await fs.readFile(pptxPath));
  // PowerPoint/WPS map the medium transition speed to 1 second. Every slide
  // uses Morph (平滑) and advances after 4 seconds; unmatched detail objects
  // fade naturally because their OOXML names are unique per player page.
  const transition = '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="p159"><p:transition spd="med" advTm="4000"><p159:morph option="byObject"/></p:transition></mc:Choice><mc:Fallback><p:transition spd="med" advTm="4000"><p:fade/></p:transition></mc:Fallback></mc:AlternateContent>';
  const slideNames = Object.keys(zip.files).filter(name => /^ppt\/slides\/slide\d+\.xml$/.test(name));
  for (const name of slideNames) {
    let xml = await zip.file(name).async('string');
    const slideNo = Number(name.match(/slide(\d+)\.xml$/)?.[1] || 0);
    xml = xml.replace(/<mc:AlternateContent\b[\s\S]*?<\/mc:AlternateContent>/g, '');
    xml = xml.replace(/<p:transition\b[^>]*>[\s\S]*?<\/p:transition>/g, '');
    xml = xml.replace(/<p:sld\b([^>]*)>/, (whole, attrs) => {
      let next = attrs;
      if (!/xmlns:p159=/.test(next)) next += ' xmlns:p159="http://schemas.microsoft.com/office/powerpoint/2015/09/main"';
      if (!/xmlns:mc=/.test(next)) next += ' xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
      if (!/mc:Ignorable=/.test(next)) next += ' mc:Ignorable="p159"';
      return `<p:sld${next}>`;
    });
    const afterContent=xml.indexOf('</p:cSld>')+'</p:cSld>'.length;
    const tail=xml.slice(afterContent),anchor=tail.search(/<p:(?:timing|extLst)\b|<\/p:sld>/);
    const insertAt=anchor<0?xml.indexOf('</p:sld>'):afterContent+anchor;
    xml=xml.slice(0,insertAt)+transition+xml.slice(insertAt);
    // Imported text keeps its original paragraph alignment even after the
    // high-level text alignment property changes. Center only the two team
    // country/name boxes at OOXML level so their left/right whitespace is
    // exactly balanced on the title slide and every compact header.
    for (const teamName of teamNames) {
      const escaped = String(teamName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const blockPattern = new RegExp(`<a:p(?:\\s[^>]*)?>(?:(?!<\\/a:p>)[\\s\\S])*?<a:t>${escaped}<\\/a:t>(?:(?!<\\/a:p>)[\\s\\S])*?<\\/a:p>`, 'g');
      xml = xml.replace(blockPattern, block => block.replace(/<a:pPr([^>]*)>/, (whole, attrs) => {
        const next = /\balgn=/.test(attrs) ? attrs.replace(/\balgn="[^"]*"/, 'algn="ctr"') : `${attrs} algn="ctr"`;
        return `<a:pPr${next}>`;
      }));
    }
    for (const [pickName, alignment] of [['!!PICK_LABEL_BLUE','l'],['!!PICK_LABEL_RED','r'],['!!PICK_LABEL_TB','r']]) {
      const pickPattern = new RegExp(`<p:sp>(?=(?:(?!<\\/p:sp>)[\\s\\S])*?name="${pickName}")(?:(?!<\\/p:sp>)[\\s\\S])*?<\\/p:sp>`, 'g');
      xml = xml.replace(pickPattern, block => block.replace(/<a:pPr([^>]*)>/g, (whole, attrs) => {
        const next = /\balgn=/.test(attrs) ? attrs.replace(/\balgn="[^"]*"/, `algn="${alignment}"`) : `${attrs} algn="${alignment}"`;
        return `<a:pPr${next}>`;
      }));
    }
    zip.file(name, xml);
  }
  await fs.writeFile(pptxPath, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

function parseNdjson(text) { return String(text || '').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }

async function records(presentation, kind, slideNo) {
  // Query the requested slide directly. The deprecated deck-wide preset has
  // a record/character cap, which silently omitted objects on late slides.
  const out = await presentation.inspect({select:`$.slides[${slideNo-1}].elements[?(@.kind == '${kind}')]`,include:['id','kind','name','text','position']});
  return (out.records || parseNdjson(out.ndjson)).map(r => ({
    ...r,
    slide: slideNo,
    bbox: r.bbox ?? (r.position ? [r.position.left,r.position.top,r.position.width,r.position.height] : undefined),
  }));
}

async function replaceOnSlide(presentation, slideNo, pairs) {
  const recs = await records(presentation, 'textbox', slideNo);
  for (const rec of recs) {
    const source = rec.text ?? '';
    let next = source;
    for (const [from, to] of pairs) {
      if (typeof from === 'string') next = next.split(from).join(q(to));
      else next = next.replace(from, q(to));
    }
    if (next !== source) presentation.resolve(rec.id).text.replace(source, next);
  }
}

function scoreRows(game, team) {
  const teamScores = (game?.scores || []).filter(s => s.team === team).sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
  return [0, 1, 2].map(i => teamScores[i] || { name: '?', score: null, statistics: {} });
}

const statAliases = {
  perfect: ['perfect','count_perfect','count_geki','count_300g'],
  great: ['great','count_great','count_300'],
  good: ['good','count_good','count_katu','count_200'],
  ok: ['ok','count_ok','count_100'],
  meh: ['meh','count_meh','count_50'],
  miss: ['miss','count_miss'],
};
const statValue = (row, key) => {
  const statistics = row?.statistics || {};
  for (const alias of statAliases[key] || [key]) if (statistics[alias] !== undefined && statistics[alias] !== null) return statistics[alias];
  return null;
};
const statLines = row => ['perfect','great','good','ok','meh','miss'].map(key => q(statValue(row,key))).join('\n');

async function setScoreData(presentation, slideNo, game, detailIndex = null) {
  const red = scoreRows(game, 'red'), blue = scoreRows(game, 'blue');
  const recs = await records(presentation, 'textbox', slideNo);
  for(const rec of recs){const text=String(rec.text||'').trim();if(text==='*'||/score from livestream/i.test(text))presentation.resolve(rec.id).delete();}
  const namesLeft = recs.filter(r => r.bbox?.[0] > 65 && r.bbox?.[0] < 330 && r.bbox?.[1] > 120 && r.bbox?.[1] < 500 && r.bbox?.[3] > 35 && r.bbox?.[3] < 55).sort((a,b)=>a.bbox[1]-b.bbox[1]).slice(0,3);
  const namesRight = recs.filter(r => r.bbox?.[0] > 980 && r.bbox?.[1] > 120 && r.bbox?.[1] < 500 && r.bbox?.[3] > 35 && r.bbox?.[3] < 55).sort((a,b)=>a.bbox[1]-b.bbox[1]).slice(0,3);
  namesLeft.forEach((rec,i)=>presentation.resolve(rec.id).text.set(red[i].name));
  namesRight.forEach((rec,i)=>presentation.resolve(rec.id).text.set(blue[i].name));
  // Some duplicated score layouts omit the left third-place badge. Restore
  // only the missing badge, using the template's fixed geometry and type size.
  const ranks = recs.filter(r => /^[123]$/.test(String(r.text||'').trim()) && r.bbox?.[1] > 120 && r.bbox?.[1] < 440);
  for (const [side,x,color] of [['left',51.23,RED],['right',1201.54,BLUE]]) {
    for (const [rank,y] of [[1,147.6],[2,253.1],[3,363.43]]) {
      const exists = ranks.some(r => String(r.text).trim() === String(rank) && (side === 'left' ? r.bbox[0] < 200 : r.bbox[0] > 1100));
      if (!exists) {
        const badge = presentation.slides.items[slideNo-1].shapes.add({name:`!!RANK_${side.toUpperCase()}_${rank}`,geometry:'rect',position:{left:x,top:y,width:32.65,height:29.25},fill:color,line:{fill:'none'}});
        const peer=ranks.find(r=>(side==='left'?r.bbox[0]<200:r.bbox[0]>1100));
        if(peer)badge.text.copyFormattingFrom(presentation.resolve(peer.id).text);
        badge.text.set(String(rank)); badge.text.typeface='Torus'; badge.text.fontSize=fontPt(18); badge.text.color='#FFFFFF'; badge.text.alignment='center'; badge.text.verticalAlignment='middle'; badge.text.wrap='none';
      }
    }
  }
  const scoreBoxes = recs.filter(r => /^SCORE\s+/i.test(String(r.text||''))).sort((a,b)=>a.bbox[1]-b.bbox[1]);
  for (const rec of scoreBoxes) {
    const side = rec.bbox[0] < 640 ? red : blue;
    const peers = scoreBoxes.filter(x => (x.bbox[0] < 640) === (rec.bbox[0] < 640));
    const index = peers.indexOf(rec);
    const target = presentation.resolve(rec.id).text;
    target.wrap='none';target.autoFit='none';
    const source = String(rec.text || '');
    const match = source.match(/(SCORE\s+)([\d,?]+\*?)/i);
    if (match) target.getRange(match.index + match[1].length, match[2].length).replace(fmt(side[index]?.score));
  }
  const totals = recs.filter(r => r.bbox?.[1] > 430 && r.bbox?.[1] < 570 && r.bbox?.[0] > 430 && r.bbox?.[0] < 850 && /^(?:<=)?\d[\d,]*$/.test(String(r.text||'').trim())).sort((a,b)=>a.bbox[0]-b.bbox[0]);
  if (totals[0]) presentation.resolve(totals[0].id).text.set(fmt(teamTotal(game,'red')));
  if (totals[1]) presentation.resolve(totals[1].id).text.set(fmt(teamTotal(game,'blue')));
  const redTotal=game?.redTotal??teamTotal(game,'red'), blueTotal=game?.blueTotal??teamTotal(game,'blue');
  const winner=game?.winner||(redTotal>blueTotal?'red':(blueTotal>redTotal?'blue':null));
  const centralDelta=recs.find(r=>r.bbox?.[1]>400&&r.bbox?.[1]<570&&r.bbox?.[0]>400&&r.bbox?.[0]<900&&/^\+[\d,?]+$/.test(String(r.text||'').trim()));
  if(centralDelta&&redTotal&&blueTotal){
    presentation.resolve(centralDelta.id).delete();
    const delta=presentation.slides.items[slideNo-1].shapes.add({name:'!!CENTRAL_DELTA',geometry:'rect',position:{left:winner==='red'?456.42:737.07,top:461,width:86,height:24},fill:'none',line:{fill:'none'}});
    delta.text.set(`+${fmt(Math.abs(redTotal-blueTotal))}`);delta.text.typeface='Torus';delta.text.fontSize=fontPt(11);delta.text.bold=false;delta.text.color='#FFFFFF';delta.text.alignment='center';delta.text.verticalAlignment='middle';delta.text.wrap='none';
  }
  if (detailIndex == null) return;
  const detailRows = [red[detailIndex], blue[detailIndex]];
  const statLabelBoxes = recs.filter(r => /^300G:\s*\n300:\s*\n200:\s*\n100:\s*\n50:\s*\nMISS:/i.test(String(r.text||'').trim())).sort((a,b)=>a.bbox[0]-b.bbox[0]);
  // The supplied template is not geometrically identical in every six-slide
  // cycle. In the third game's red-player-2 detail slide, the judgement value
  // box is 156.72 px high while the other copies are below 150 px. Matching by
  // a hard-coded height therefore skipped the red box and wrote the red data
  // into the blue box. Pair each value box with its adjacent judgement-label
  // box instead; this also tolerates trailing blank lines and minor WPS layout
  // differences.
  const isStatValues = rec => {
    const lines = String(rec.text || '').trim().split(/\s*\n\s*/);
    return lines.length === 6 && lines.every(line => /^(?:[\d,]+|\?)$/.test(line));
  };
  const valueCandidates = recs.filter(isStatValues);
  const statBoxes = statLabelBoxes.map(label => {
    const labelCenterY = label.bbox[1] + label.bbox[3] / 2;
    const sameSide = valueCandidates.filter(value =>
      (value.bbox[0] < 640) === (label.bbox[0] < 640) &&
      Math.abs((value.bbox[1] + value.bbox[3] / 2) - labelCenterY) < 35
    );
    return sameSide.sort((a, b) =>
      Math.abs(a.bbox[0] - label.bbox[0]) - Math.abs(b.bbox[0] - label.bbox[0])
    )[0];
  });
  statLabelBoxes.forEach((rec,i)=>{
    // Labels and white values must be unmatched Morph objects together, so
    // both halves fade in/out instead of the pink labels remaining stationary.
    presentation.resolve(rec.id).name=`!!JUDGEMENT_LABELS_${slideNo}_${i===0?'RED':'BLUE'}`;
  });
  statBoxes.forEach((rec,i)=>{
    if (!rec) return;
    const target=presentation.resolve(rec.id);
    target.name=`!!JUDGEMENTS_${slideNo}_${i===0?'RED':'BLUE'}`;
    target.text.set(statLines(detailRows[i]));
  });
  const accuracyBoxes = recs.filter(r => /^ACCURACY/i.test(String(r.text||''))).sort((a,b)=>a.bbox[0]-b.bbox[0]);
  accuracyBoxes.forEach((rec,i)=>{
    const row=detailRows[i], accuracy=row?.accuracy==null?'?':`${(Number(row.accuracy)*100).toFixed(2)}%`;
    const combo = row?.maxCombo == null ? '?' : fmt(row.maxCombo);
    const text = presentation.resolve(rec.id).text;
    text.wrap='none';text.autoFit='none';
    const source = String(rec.text || '');
    const comboMatch = source.match(/(MAX COMBO\s+)([\d,?]+)/i);
    let comboAt = -1;
    if (comboMatch) {
      comboAt = comboMatch.index + comboMatch[1].length;
      text.getRange(comboAt, comboMatch[2].length).replace(combo);
    }
    const accuracyMatch = source.match(/(ACCURACY\s+)([\d.?]+%?)/i);
    if (accuracyMatch) text.getRange(accuracyMatch.index + accuracyMatch[1].length, accuracyMatch[2].length).replace(accuracy);
    const beatmap = game?.beatmap || {};
    const expectedCombo = Number((beatmap.count_circles || 0) + (beatmap.count_sliders || 0) * 2);
    const comboReached = Number(row?.maxCombo) > 0 && Number(row?.maxCombo) === expectedCombo;
    const meh = statValue(row, 'meh'), miss = statValue(row, 'miss');
    const cleanJudgements = meh !== null && miss !== null && Number(meh) === 0 && Number(miss) === 0;
    const fullCombo = comboReached || cleanJudgements;
    if (comboAt >= 0) text.getRange(comboAt, combo.length).color = fullCombo ? '#00FF00' : '#FF66AB';
  });
}

async function setBpInfo(presentation, slideNo, input) {
  const recs=await records(presentation,'textbox',slideNo);
  const labels=recs.filter(r=>/^(?:Roll|Protect|Ban)$/i.test(String(r.text||'').trim())&&r.bbox?.[1]>570);
  const values=recs.filter(r=>r.bbox?.[1]>540&&r.bbox?.[0]<543&&!/^(?:Roll|Protect|Ban)$/i.test(String(r.text||'').trim()));
  for(const label of labels){
    const kind=String(label.text).trim().toLowerCase();
    const cx=label.bbox[0]+label.bbox[2]/2, cy=label.bbox[1]+label.bbox[3]/2;
    const column=values.filter(r=>Math.abs((r.bbox[0]+r.bbox[2]/2)-cx)<45);
    const above=column.filter(r=>r.bbox[1]+r.bbox[3]/2<cy).sort((a,b)=>(cy-(a.bbox[1]+a.bbox[3]/2))-(cy-(b.bbox[1]+b.bbox[3]/2)))[0];
    const below=column.filter(r=>r.bbox[1]+r.bbox[3]/2>cy).sort((a,b)=>((a.bbox[1]+a.bbox[3]/2)-cy)-((b.bbox[1]+b.bbox[3]/2)-cy))[0];
    const topValue=kind==='roll'?input.redRoll:(kind==='protect'?input.redProtect:input.redBan);
    const bottomValue=kind==='roll'?input.blueRoll:(kind==='protect'?input.blueProtect:input.blueBan);
    const labelText=presentation.resolve(label.id).text;
    labelText.typeface='Torus';labelText.outline={style:'solid',fill:'#000000',width:1};
    if(above){const text=presentation.resolve(above.id).text;text.set(q(topValue));text.typeface='Torus';text.outline={style:'solid',fill:kind==='ban'?'#BFC2C7':'#FFFFFF',width:1};}
    if(below){const text=presentation.resolve(below.id).text;text.set(q(bottomValue));text.typeface='Torus';text.outline={style:'solid',fill:kind==='ban'?'#BFC2C7':'#FFFFFF',width:1};}
  }
}

async function setMapInfo(presentation, slideNo, map, game) {
  const b=game?.beatmap||{}, set=b.beatmapset||{};
  const version=String(b.version||'').replace(/^\[\d+K\]\s*/i,'');
  const title=set.artist&&set.title?`${set.artist} - ${set.title} [${version||'?'}]`:'?';
  const mapper=set.creator||b.creator||'?';
  const length=q(b.total_length?`${Math.floor(b.total_length/60)}:${String(b.total_length%60).padStart(2,'0')}`:null);
  const star=b.difficulty_rating==null?'?':Number(b.difficulty_rating).toFixed(2);
  const noteCount=b.count_circles==null?'?':fmt(b.count_circles);
  const lnCount=b.count_sliders==null?'?':fmt(b.count_sliders);
  const comboCount=b.count_circles==null||b.count_sliders==null?'?':fmt(Number(b.count_circles)+Number(b.count_sliders)*2);
  const recs=await records(presentation,'textbox',slideNo);
  const metricRecs=recs.filter(r=>String(r.text||'').includes('LENGTH')||String(r.text||'').includes('Notes'));
  const metricTop=Math.min(...metricRecs.map(r=>r.bbox?.[1]??Infinity));
  const metricHeight=Math.max(...metricRecs.map(r=>r.bbox?.[3]??0));
  const titleRec=recs.find(r=>{const t=String(r.text||''),box=r.bbox||[];return box[1]>200&&box[1]<500&&box[0]>350&&box[0]<950&&box[3]>40&&!t.includes('LENGTH')&&!t.includes('Notes')&&t.includes('[');});
  let mapperTop=null, shiftedMetricTop=metricTop;
  if(titleRec&&Number.isFinite(metricTop)&&!b.deleted){
    // Keep the original template width. Estimate the number of rendered lines
    // at the fixed 18 pt size, then move only the lower metadata when the title
    // actually needs the extra vertical room.
    const glyphWeight=word=>[...word].reduce((n,ch)=>n+(ch===' '?0.28:/[A-Z0-9]/.test(ch)?0.58:/[a-z]/.test(ch)?0.48:ch.charCodeAt(0)>255?1:0.35),0)*0.8;
    const capacity=Math.max(1,titleRec.bbox[2]-12)/fontPt(18);
    let lineCount=1,lineWeight=0;
    for(const word of title.split(/\s+/)){
      const wordWeight=glyphWeight(word),next=lineWeight+(lineWeight?glyphWeight(' '):0)+wordWeight;
      if(lineWeight&&next>capacity){lineCount++;lineWeight=wordWeight;}else lineWeight=next;
    }
    // Very long tournament difficulty names tend to wrap once more in
    // PowerPoint/WPS because wrapping happens at punctuation boundaries too.
    if(title.length>85)lineCount=Math.max(lineCount,4);
    const titleBottom=titleRec.bbox[1]+lineCount*30;
    mapperTop=Math.max(titleBottom+2,metricTop-27);
    const desiredMetricTop=Math.max(metricTop,mapperTop+22);
    const centralTop=Math.min(...recs.filter(r=>r.name==='!!CENTRAL_DELTA'||(r.bbox?.[1]>430&&r.bbox?.[1]<560&&/^\+?[\d,]+$/.test(String(r.text||'').trim()))).map(r=>r.bbox?.[1]??Infinity));
    const maxMetricTop=Number.isFinite(centralTop)?centralTop-metricHeight-4:desiredMetricTop;
    shiftedMetricTop=Math.max(metricTop,Math.min(desiredMetricTop,maxMetricTop));
    mapperTop=Math.min(mapperTop,shiftedMetricTop-20);
  }
  for(const rec of recs){const t=rec.text||'',box=rec.bbox||[],target=presentation.resolve(rec.id).text;
    if(box[1]>100&&box[1]<360&&box[0]>700&&box[0]<1050&&box[2]<100&&box[3]<55){target.set(map.code);continue;}
    if(box[1]>200&&box[1]<500&&box[0]>350&&box[0]<950&&box[3]>40&&!t.includes('LENGTH')&&!t.includes('Notes')&&t.includes('[')){
      if(b.deleted){target.set('?');continue;}
      const by=t.indexOf('\nBy ');
      if(by>=0){
        target.getRange(by,t.length-by).replace('');
        target.getRange(0,by).replace(title);
        const titleShape=presentation.resolve(rec.id);
        const actualMapperTop=Number.isFinite(mapperTop)?mapperTop:(Number.isFinite(metricTop)?Math.max(box[1]+24,metricTop-27):box[1]+box[3]-22);
        titleShape.position.height=Math.max(24,actualMapperTop-box[1]-3);
        titleShape.text.fontSize=fontPt(18);
        const mapperBox=presentation.slides.items[slideNo-1].shapes.add({name:'!!MAP_MAPPER',geometry:'rect',position:{left:box[0],top:actualMapperTop,width:box[2],height:18},fill:'none',line:{fill:'none'}});
        mapperBox.text.set(`By ${mapper}`);mapperBox.text.typeface='Torus Bold';mapperBox.text.fontSize=fontPt(11);mapperBox.text.bold=false;mapperBox.text.color='#FFFFFF';mapperBox.text.alignment='right';mapperBox.text.verticalAlignment='middle';mapperBox.text.wrap='none';mapperBox.text.autoFit='none';
      }
      else target.getRange(0,t.length).replace(title);
      target.wrap='square';
      target.autoFit='none';
      continue;
    }
    if(t.includes('LENGTH')&&t.includes('BPM')&&t.includes('STAR RATING')){
      for(const [re,value] of [[/(STAR RATING\s+)([^\n]+)/,star],[/(BPM\s+)([^\n]+)/,q(b.bpm)],[/(LENGTH\s+)([^\n]+)/,length]]){const m=t.match(re);if(m)target.getRange(m.index+m[1].length,m[2].length).replace(value);}
      if(Number.isFinite(shiftedMetricTop))presentation.resolve(rec.id).position.top=shiftedMetricTop;
      continue;
    }
    if(t.includes('Notes')&&t.includes('LNs')&&t.includes('Combos')){
      for(const [re,value] of [[/([^\n\s]+)\s+Combos/,comboCount],[/([^\n\s]+)\s+LNs/,lnCount],[/([^\n\s]+)\s+Notes/,noteCount]]){const m=t.match(re);if(m)target.getRange(m.index,m[1].length).replace(value);}
      if(Number.isFinite(shiftedMetricTop))presentation.resolve(rec.id).position.top=shiftedMetricTop;
    }
  }
}

const copyFrame = frame => frame ? { left:frame.left, top:frame.top, width:frame.width, height:frame.height } : null;

async function replaceCover(presentation, slideNo, beatmap, component = null) {
  if (beatmap?.deleted) {
    const imgs = await records(presentation, 'image', slideNo);
    if (imgs[0]) presentation.resolve(imgs[0].id).delete();
    return;
  }
  const url = beatmap?.beatmapset?.covers?.cover || beatmap?.beatmapset?.covers?.card;
  if (!url) {
    for (const rec of await records(presentation, 'image', slideNo)) {
      const box=rec.bbox||[]; if(box[0]>300&&box[0]<950&&box[1]>90&&box[1]<380)presentation.resolve(rec.id).delete();
    }
    return null;
  }
  try {
    let cached = coverCache.get(url);
    if (!cached) {
      let lastError;
      for (let attempt = 1; attempt <= 5; attempt++) {
        const res = await fetchWithRetry(url, {}, 'osu! 曲绘');
        if (res.ok) {
          const contentType = res.headers.get('content-type') || 'image/jpeg';
          const declaredSize = Number(res.headers.get('content-length') || 0);
          if (declaredSize > 20 * 1024 * 1024) throw new Error('曲绘文件超过 20 MB，已跳过');
          const bytes = Buffer.from(await res.arrayBuffer());
          if (bytes.length > 20 * 1024 * 1024) throw new Error('曲绘文件超过 20 MB，已跳过');
          // Store a presentation-sized copy. This prevents unusually large
          // cover files from exhausting the exporter and keeps PPTX size
          // stable when many maps are present.
          const optimized = await sharp(bytes, { limitInputPixels: 80_000_000 })
            .rotate().resize({ width: 1600, height: 900, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 88, mozjpeg: true }).toBuffer();
          cached = { dataUrl: `data:image/jpeg;base64,${optimized.toString('base64')}` };
          coverCache.set(url, cached);
          break;
        }
        lastError = new Error(`HTTP ${res.status}`);
        if (res.status !== 429 && res.status < 500) break;
        if (attempt < 5) {
          const retryAfter = Number(res.headers.get('retry-after'));
          await new Promise(resolve => setTimeout(resolve, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : attempt * 750));
        }
      }
      if (!cached) throw lastError || new Error('封面下载失败');
    }
    const imgs = await records(presentation, 'image', slideNo);
    const img = imgs[0] ? presentation.resolve(imgs[0].id) : null;
    if (!img && !component?.imageFrame) return null;
    const frame = copyFrame(component?.imageFrame || img.frame);
    const crop = component?.crop ?? img?.crop;
    const fit = component?.fit ?? img?.fit;
    const geometry = component?.geometry ?? img?.geometry;
    // Keep the media identity unique. Reusing the same alt/asset identity for
    // many imported slides can make the PPTX exporter reuse an earlier image
    // relationship even though the downloaded bytes are different.
    const mediaIdentity = component?.compositeDataUrl
      ? `Beatmap ${beatmap.id || beatmap.beatmapset_id || 'unknown'} background and pool code slide ${slideNo}`
      : `Beatmap cover ${beatmap.id || beatmap.beatmapset_id || 'unknown'} slide ${slideNo}`;
    // Imported duplicate slides can share the same underlying media relation.
    // Replacing that relation makes the last map overwrite every earlier map.
    // Delete and add a slide-local image so every slide owns its own media part.
    if (img) img.delete();
    const visualDataUrl = component?.compositeDataUrl || cached.dataUrl;
    const fresh = presentation.slides.items[slideNo - 1].images.add({ dataUrl: visualDataUrl, alt: mediaIdentity, position: frame, fit:component?.compositeDataUrl?'fill':fit, crop:component?.compositeDataUrl?undefined:crop, geometry });
    fresh.name = component?.compositeDataUrl ? `!!MAP_VISUAL_${slideNo}` : `!!MAP_BG_${slideNo}`;
    fresh.frame = frame; fresh.crop = crop; fresh.fit = fit; fresh.geometry = geometry;
    for (const rec of await records(presentation, 'textbox', slideNo)) presentation.resolve(rec.id).bringToFront();
    return { imageFrame:copyFrame(frame), crop, fit, geometry };
  } catch (error) {
    // Cover art is decorative. A corrupt, oversized or temporarily
    // unavailable image must never abort the data deck.
    const imgs = await records(presentation, 'image', slideNo).catch(() => []);
    for (const rec of imgs) if ((rec.bbox?.[0] ?? 0) > 300 && (rec.bbox?.[0] ?? 0) < 950) presentation.resolve(rec.id).delete();
    return null;
  }
}

async function removeMapVisual(presentation, slideNo) {
  for (const rec of await records(presentation, 'image', slideNo)) {
    const box = rec.bbox || [];
    if (box[0] > 300 && box[0] < 950 && box[1] > 90 && box[1] < 380) presentation.resolve(rec.id).delete();
  }
  for (const rec of await records(presentation, 'textbox', slideNo)) {
    const text = String(rec.text || '').trim(), box = rec.bbox || [];
    if (box[0] > 300 && box[0] < 1100 && box[1] > 90 && box[1] < 230 && /^(?:RC|LN|HB|NM|HD|HR|DT|FM|TB)\d*$/i.test(text)) presentation.resolve(rec.id).delete();
  }
}

async function setScoreBoxes(presentation, slideNo, winsNeeded, redWins, blueWins) {
  const textboxes = await records(presentation, 'textbox', slideNo);
  const shapes = (await records(presentation, 'shape', slideNo)).filter(r => r.bbox && r.bbox[1] < 90 && r.bbox[2] > 20 && r.bbox[2] < 40 && r.bbox[3] > 20 && r.bbox[3] < 40);
  const left = shapes.filter(r => r.bbox[0] > 120 && r.bbox[0] < 500).sort((a,b) => a.bbox[0] - b.bbox[0]);
  const right = shapes.filter(r => r.bbox[0] > 780 && r.bbox[0] < 1130).sort((a,b) => a.bbox[0] - b.bbox[0]);
  for(const rec of [...left,...right])presentation.resolve(rec.id).delete();
  const slide=presentation.slides.items[slideNo-1];
  const teamRed=textboxes.find(r=>String(r.text||'').trim()==='TEAM RED'&&r.bbox?.[1]<50);
  const teamBlue=textboxes.find(r=>String(r.text||'').trim()==='TEAM BLUE'&&r.bbox?.[1]<50);
  const cellWidth=29.25, step=34.01, edgeGap=4.8;
  const redStart=teamRed?.bbox?teamRed.bbox[0]+teamRed.bbox[2]+edgeGap:133.93;
  const blueStart=teamBlue?.bbox?teamBlue.bbox[0]-edgeGap-(cellWidth+step*(winsNeeded-1)):900.63;
  for(const [side,won,start,top] of [['RED',redWins,redStart,13.77],['BLUE',blueWins,blueStart,13.85]])for(let i=0;i<winsNeeded;i++){
    const filled = side === 'RED' ? i < won : i >= winsNeeded - won;
    slide.shapes.add({name:`!!SCORE_${side}_${i+1}`,geometry:'rect',position:{left:start+i*34.01,top,width:29.25,height:29.25},fill:filled?'#FFE9A6':{type:'none'},line:{style:'solid',fill:'#808080',width:1}});
  }
}

async function stylePick(presentation, slideNo, mapCode, picker, component = null) {
  const isTb = String(mapCode).trim().toUpperCase() === 'TB';
  const color = isTb ? TB : (picker === 'red' ? RED : BLUE);
  const recs = await records(presentation, 'textbox', slideNo);
  const slide=presentation.slides.items[slideNo-1];
  let codeBox = null;
  let codeStyle = null;
  for (const rec of recs) {
    const text = String(rec.text || '').trim();
    const box = rec.bbox || [];
    if (text.endsWith('Pick') && box[1] > 200 && box[1] < 500) {
      const original=presentation.resolve(rec.id);original.delete();
      const labelLeft=isTb?box[0]:(picker==='red'?97.19:904.86);
      const labelName=isTb?'!!PICK_LABEL_TB':`!!PICK_LABEL_${picker.toUpperCase()}`;
      const label=slide.shapes.add({name:labelName,geometry:'rect',position:{left:labelLeft,top:box[1],width:277.95,height:box[3]},fill:{type:'solid',color},line:{fill:'none'}});
      label.text.copyFormattingFrom(original.text);
      label.text.set(text);label.text.typeface='Torus';label.text.fontSize=fontPt(32);label.text.color='#FFFFFF';label.text.alignment=picker==='blue'&&!isTb?'left':'right';label.text.verticalAlignment='middle';label.text.wrap='none';label.text.autoFit='none';
      label.bringToFront();
    } else if (text === String(mapCode).trim() && box[1] > 100 && box[1] < 360) {
      const original=presentation.resolve(rec.id);if(!codeStyle)codeStyle=original.text;original.delete();
      if (!codeBox) codeBox = {left:box[0],top:box[1],width:box[2],height:box[3]};
    }
  }
  codeBox = copyFrame(component?.codeFrame || codeBox);
  if (codeBox && !component?.compositeDataUrl) {
    const label=slide.shapes.add({name:`!!MAP_CODE_LABEL_${slideNo}`,geometry:'rect',position:codeBox,fill:{type:'solid',color},line:{fill:'none'}});
    if(codeStyle)label.text.copyFormattingFrom(codeStyle);
    label.text.set(String(mapCode).trim());label.text.typeface='Torus';label.text.fontSize=fontPt(16);label.text.color='#FFFFFF';label.text.alignment='center';label.text.verticalAlignment='middle';label.text.wrap='none';label.text.autoFit='none';
    label.text.outline={style:'solid',fill:'#FFFFFF',width:1};
    label.bringToFront();
  }
  return { codeFrame:codeBox };
}

async function setProgressBar(presentation, slideNo, games, currentIndex, firstPicker, showCurrentResult) {
  const textRecs = await records(presentation, 'textbox', slideNo);
  const codeRecs = textRecs.filter(r => r.bbox?.[0] >= 500 && r.bbox?.[1] > 540 && /^(?:(?:RC|LN|HB|NM|HD|HR|DT|FM)\d+|TB|\?)$/.test(String(r.text||'').trim()));
  const deltaRecs = textRecs.filter(r => r.bbox?.[0] >= 500 && r.bbox?.[1] > 540 && /^\+[\d,?]+$/.test(String(r.text||'').trim()));
  if (!codeRecs.length) return;
  const slide = presentation.slides.items[slideNo - 1];
  for (const rec of [...codeRecs, ...deltaRecs]) presentation.resolve(rec.id).delete();
  const sourceGlows = (await records(presentation, 'shape', slideNo)).filter(r => r.bbox?.[0] >= 500 && r.bbox?.[1] > 540 && r.bbox?.[2] < 90 && r.bbox?.[3] > 32 && r.bbox?.[3] < 50);
  for (const glow of sourceGlows) presentation.resolve(glow.id).delete();
  const visibleCount = currentIndex + 1;
  const layoutCount = Math.max(1, games.length);
  // Match the source Protect/Ban value cells exactly so every center-row box
  // shares the same top and bottom baseline.
  const itemWidth = 60.47, itemHeight = 35.54, itemTop = 615.88;
  const gap = layoutCount > 10 ? 4 : 8;
  const pickWidth = itemWidth * layoutCount + gap * (layoutCount - 1);
  // Match the generated pick cells to the template's Protect cell width, then
  // center the complete BP + pick rail as one unit.
  const bpCandidates = [
    ...(await records(presentation, 'textbox', slideNo)),
    ...(await records(presentation, 'shape', slideNo)),
  ].filter(r => r.bbox?.[0] >= 240 && r.bbox?.[0] < 543 && r.bbox?.[1] > 540);
  const bpItems = [...new Map(bpCandidates.map(r => [r.id, r])).values()];
  const bpLeft = Math.min(...bpItems.map(r => r.bbox[0]));
  const bpRight = Math.max(...bpItems.map(r => r.bbox[0] + r.bbox[2]));
  const bpWidth = Number.isFinite(bpLeft) && Number.isFinite(bpRight) ? bpRight - bpLeft : 264;
  const railGap = 12;
  const groupWidth = bpWidth + railGap + pickWidth;
  const groupLeft = (1280 - groupWidth) / 2;
  if (Number.isFinite(bpLeft)) for (const rec of bpItems) presentation.resolve(rec.id).position.left += groupLeft - bpLeft;
  const startX = groupLeft + bpWidth + railGap;
  // Template glow assets can carry the opposite team's color. They are removed
  // before any centering movement, then recreated from the actual winner.
  for (let i = 0; i < visibleCount; i++) {
    const game = games[i], code = String(game?.poolMap?.code || '?');
    const picker = i % 2 === 0 ? firstPicker : (firstPicker === 'red' ? 'blue' : 'red');
    const hasResult = i < currentIndex || showCurrentResult;
    const winner = game?.winner || (game?.redTotal > game?.blueTotal ? 'red' : (game?.blueTotal > game?.redTotal ? 'blue' : null));
    const difference = game?.redTotal != null && game?.blueTotal != null ? Math.abs(Number(game.redTotal)-Number(game.blueTotal)) : game?.difference;
    const color = code.toUpperCase() === 'TB' ? TB : (picker === 'red' ? RED : BLUE);
    const left = startX + i * (itemWidth + gap);
    let glow = null;
    if (hasResult && difference != null) {
      const deltaTop=winner==='red'?574.12:itemTop+itemHeight;
      glow = slide.shapes.add({name:`!!PROGRESS_GLOW_${String(i+1).padStart(2,'0')}`,geometry:'rect',position:{left,top:deltaTop,width:itemWidth,height:winner==='red'?itemTop-574.12:41.97},fill:winner==='red'?`linear(90deg, ${RED}/0 0%, ${RED} 100%)`:`linear(90deg, ${BLUE} 0%, ${BLUE}/0 100%)`,line:{fill:'none'}});
    }
    if (hasResult && difference != null) {
      // Both upper and lower deltas use the same 11 pt type and the same
      // optical gap from the central code cell.
      const deltaTextTop = winner === 'red' ? itemTop-27.47 : itemTop+itemHeight;
      const delta = slide.shapes.add({ name:`!!PROGRESS_DELTA_${String(i+1).padStart(2,'0')}`, geometry:'rect', position:{left:left-7,top:deltaTextTop,width:itemWidth+14,height:27.47}, fill:'none', line:{fill:'none'} });
      delta.text.set(`+${fmt(difference)}`); delta.text.typeface='Torus'; delta.text.fontSize=fontPt(11); delta.text.bold=false; delta.text.color='#FFFFFF'; delta.text.alignment='center'; delta.text.verticalAlignment='middle'; delta.text.wrap='none'; delta.text.autoFit='none';
      delta.text.outline={style:'solid',fill:'#FFFFFF',width:1};
    }
    // Creation order is the reliable OOXML z-order. Add the ID cell last so
    // WPS places it above both the glow and the delta text box.
    const codeBox = slide.shapes.add({ name:`!!PROGRESS_CODE_${String(i+1).padStart(2,'0')}`, geometry:'rect', position:{left,top:itemTop,width:itemWidth,height:itemHeight}, fill:color, line:{fill:'none'} });
    codeBox.text.set(code); codeBox.text.typeface='Torus'; codeBox.text.fontSize=fontPt(16); codeBox.text.bold=true; codeBox.text.getRange(0,code.length).bold=true; codeBox.text.color='#FFFFFF'; codeBox.text.alignment='center'; codeBox.text.verticalAlignment='middle'; codeBox.text.wrap='none'; codeBox.text.autoFit='none';
    codeBox.text.outline={style:'solid',fill:'#FFFFFF',width:1};
  }
}

async function setPickLabel(presentation, slideNo, pickerName) {
  const recs = await records(presentation, 'textbox', slideNo);
  for (const rec of recs) {
    const box = rec.bbox || [];
    if (String(rec.text || '').trim().endsWith('Pick') && box[1] > 200 && box[1] < 500) {
      presentation.resolve(rec.id).text.set(`${pickerName}\nPick`);
      const target = presentation.resolve(rec.id);
      target.text.wrap = 'none';
      target.text.autoFit = 'shrinkText';
    }
  }
}

async function setTeamNames(presentation, slideNo, input) {
  const recs = await records(presentation, 'textbox', slideNo);
  const blueHeader=recs.find(r=>String(r.text||'').trim()==='TEAM BLUE'&&r.bbox?.[1]<60);
  const blueRight=blueHeader?.bbox?blueHeader.bbox[0]+blueHeader.bbox[2]:null;
  const candidates = slideNo === 2
    ? recs.filter(r => r.bbox?.[1] > 380 && r.bbox?.[1] < 480 && r.bbox?.[3] > 55)
    : recs.filter(r => r.bbox?.[1] > 40 && r.bbox?.[1] < 85 && (r.bbox?.[0] < 200 || r.bbox?.[0] > 1080));
  for (const rec of candidates) {
    const left = rec.bbox[0] < 640;
    const value = left ? input.redTeam : input.blueTeam;
    const target = presentation.resolve(rec.id);
    target.text.set(String(value).replace(/\s+/g, ' ').trim());
    target.text.wrap = 'none';
    target.text.autoFit = 'none';
    target.text.alignment = 'center';
    target.text.verticalAlignment = 'middle';
    const needed=Math.max(slideNo===2?90:rec.bbox[2],await textWidth(value,target.text)+28);
    const right = rec.bbox[0] + rec.bbox[2];
    target.position.width = needed;
    // On the title slide both team blocks share a fixed left edge with their
    // TEAM/seed boxes. On the compact header the right team remains right-
    // anchored while its white region expands leftward.
    if (!left && slideNo !== 2) target.position.left = (blueRight ?? right) - needed;
  }
}

async function setSeedBoxes(presentation, slideNo, input) {
  const recs = await records(presentation, 'textbox', slideNo);
  const blueHeader=recs.find(r=>String(r.text||'').trim()==='TEAM BLUE'&&r.bbox?.[1]<60);
  const blueRight=blueHeader?.bbox?blueHeader.bbox[0]+blueHeader.bbox[2]:null;
  const candidates = recs.filter(r => /^#?\d+$/.test(String(r.text || '').replace(/\s+/g,'')) && (
    slideNo === 2 ? r.bbox?.[1] > 450 && r.bbox?.[1] < 560 : r.bbox?.[1] > 65 && r.bbox?.[1] < 125
  ));
  for (const rec of candidates) {
    const target = presentation.resolve(rec.id);
    const value = rec.bbox[0] < 640 ? input.redSeed : input.blueSeed;
    // text.set discards all stale runs left by token replacement in imported
    // PPTX files. Those stale runs are rendered as a second line by WPS.
    target.text.set(String(value).replace(/\s+/g,'').trim());
    target.text.wrap = 'none';
    target.text.autoFit = 'none';
    target.text.alignment = 'center';
    target.text.verticalAlignment = 'middle';
    target.position.width = Math.max(rec.bbox[2], 55);
    if (rec.bbox[0] >= 640 && slideNo !== 2 && Number.isFinite(blueRight)) {
      target.position.left = blueRight - target.position.width;
    }
  }
}

async function setRoundBoxWidth(presentation, slideNo, round) {
  const recs = await records(presentation, 'textbox', slideNo);
  const rec = recs.find(r => String(r.text||'').trim() === String(round).trim() && r.bbox?.[1] > 35 && r.bbox?.[1] < 120 && r.bbox?.[0] > 450 && r.bbox?.[0] < 850);
  if (!rec) return;
  const target = presentation.resolve(rec.id);
  const center = rec.bbox[0] + rec.bbox[2] / 2;
  const needed = Math.max(rec.bbox[2], await textWidth(round,target.text)+28);
  target.position.left = center - needed / 2; target.position.width = needed;
  target.text.wrap = 'none'; target.text.autoFit = 'none';
}

async function setWinnerSlide(presentation, slideNo, { redWins, blueWins, input }) {
  const redWon = redWins > blueWins;
  const winner = redWon ? input.redTeam : input.blueTeam;
  const seed = redWon ? input.redSeed : input.blueSeed;
  const teamLabel = redWon ? 'TEAM RED' : 'TEAM BLUE';
  const recs = await records(presentation, 'textbox', slideNo);
  for (const rec of recs) {
    const box = rec.bbox || [];
    const target = presentation.resolve(rec.id);
    if (box[0] < 600 && box[1] > 200) target.text.set(`${redWins} - ${blueWins}`);
    else if (box[0] > 650 && box[1] > 340 && box[1] < 430) { target.text.set(winner); target.text.wrap='none'; target.text.autoFit='none'; target.position.width=Math.max(box[2],[...winner].length*30+18); }
    else if (box[0] > 650 && box[1] > 430) target.text.set(seed);
    else if (box[0] > 650 && box[1] > 290 && box[1] < 355) { target.text.set(teamLabel); target.fill = redWon ? RED : BLUE; }
  }
}

const stdRows = (game, team) => (game?.scores || []).filter(row => row.team === team)
  .sort((a,b)=>(Number(b.score)||0)-(Number(a.score)||0)).slice(0,4)
  .concat(Array(4).fill(null)).slice(0,4).map(row => row || {name:'?',score:null,statistics:{},mods:[]});

async function addStdModIcons(presentation, slideNo, rows, side) {
  const slide = presentation.slides.items[slideNo - 1];
  // Every OWC score-page variant already contains one MOD image frame per
  // player.  Reuse those exact frames instead of assuming that all variants
  // share the same row pitch: some pages use 82.5 pt while others use 94 pt.
  const imageRecords = await records(presentation,'image',slideNo);
  const placeholders = imageRecords.filter(rec => {
    const box=rec.bbox||[];
    const onSide = side === 'red' ? box[0] < 150 : box[0] > 1130;
    return onSide && box[1] > 110 && box[1] < 560 && box[2] < 80 && box[3] < 70;
  }).sort((a,b)=>a.bbox[1]-b.bbox[1]).slice(0,4);
  for (const rec of placeholders) presentation.resolve(rec.id).delete();

  const textRecords = await records(presentation,'textbox',slideNo);
  const ranks = textRecords.filter(rec => {
    const box=rec.bbox||[];
    const onSide = side === 'red' ? box[0] < 100 : box[0] > 1180;
    return onSide && /^[1-4]$/.test(String(rec.text||'').trim()) && box[1] > 120 && box[1] < 540;
  }).sort((a,b)=>a.bbox[1]-b.bbox[1]);
  const direction = side === 'red' ? 1 : -1;
  for (let index=0; index<4; index++) {
    const mods = [...new Set((rows[index]?.mods || []).map(x=>String(x).toUpperCase()).filter(x=>x && x!=='NF' && ['HD','HR','DT'].includes(x)))];
    const frame = placeholders[index]?.bbox;
    const rank = ranks[index]?.bbox;
    const width = frame?.[2] ?? 54.55;
    const height = frame?.[3] ?? 51.04;
    const anchorX = frame?.[0] ?? (rank ? rank[0] - (side === 'red' ? 5.47 : 16.27) : (side === 'red' ? 45.76 : 1185.27));
    const top = frame?.[1] ?? (rank ? rank[1] + (side === 'red' ? 31.56 : 29.77) : (side === 'red' ? 179.16 : 179.68) + index*82.5);
    for (let modIndex=0; modIndex<mods.length; modIndex++) {
      const mod = mods[modIndex], file = path.join(modAssetDir, `${mod}.png`);
      try {
        const data = await fs.readFile(file);
        const gap=3;
        const left = anchorX + direction*modIndex*(width+gap);
        const icon=slide.images.add({dataUrl:`data:image/png;base64,${data.toString('base64')}`,alt:`${mod} mod`,position:{left,top,width,height},fit:'contain'});
        icon.name=`!!MOD_${side.toUpperCase()}_${index+1}_${mod}`;
      } catch {}
    }
  }
}

async function setStdScoreData(presentation, slideNo, game, detailIndex = null, showImpact = false) {
  const red=stdRows(game,'red'), blue=stdRows(game,'blue'), recs=await records(presentation,'textbox',slideNo);
  const ranksLeft=recs.filter(r=>/^[1-4]$/.test(String(r.text||'').trim())&&r.bbox?.[0]<100&&r.bbox?.[1]>120&&r.bbox?.[1]<540).sort((a,b)=>a.bbox[1]-b.bbox[1]);
  const ranksRight=recs.filter(r=>/^[1-4]$/.test(String(r.text||'').trim())&&r.bbox?.[0]>1180&&r.bbox?.[1]>120&&r.bbox?.[1]<540).sort((a,b)=>a.bbox[1]-b.bbox[1]);
  const candidateName=r=>!/^SCORE/i.test(String(r.text||''))&&!/^[1-4]$/.test(String(r.text||'').trim())&&r.bbox?.[3]>25&&r.bbox?.[3]<55;
  const namesLeft=ranksLeft.map(rank=>recs.filter(r=>candidateName(r)&&r.bbox[0]>70&&r.bbox[0]<450&&Math.abs(r.bbox[1]-rank.bbox[1])<18).sort((a,b)=>Math.abs(a.bbox[0]-82)-Math.abs(b.bbox[0]-82))[0]);
  const namesRight=ranksRight.map(rank=>recs.filter(r=>candidateName(r)&&r.bbox[0]>750&&r.bbox[0]<1210&&Math.abs(r.bbox[1]-rank.bbox[1])<18).sort((a,b)=>Math.abs((b.bbox[0]+b.bbox[2])-1202)-Math.abs((a.bbox[0]+a.bbox[2])-1202))[0]);
  namesLeft.forEach((r,i)=>{if(r){const shape=presentation.resolve(r.id);shape.text.set(red[i].name);shape.text.alignment='left';shape.text.wrap='none';shape.text.autoFit='none';shape.position.left=82.34;shape.position.width=350;}});
  namesRight.forEach((r,i)=>{if(r){const shape=presentation.resolve(r.id);shape.text.set(blue[i].name);shape.text.alignment='right';shape.text.wrap='none';shape.text.autoFit='none';shape.position.left=852.1;shape.position.width=350;}});
  const scoreBoxes=recs.filter(r=>/^SCORE\s+/i.test(String(r.text||'')));
  for(const [side,rows] of [['red',red],['blue',blue]]){
    const boxes=scoreBoxes.filter(r=>(r.bbox[0]<640)===(side==='red')).sort((a,b)=>a.bbox[1]-b.bbox[1]).slice(0,4);
    boxes.forEach((rec,i)=>{const source=String(rec.text||''),m=source.match(/(SCORE\s+)([\d,?]+)/i),target=presentation.resolve(rec.id).text;target.wrap='none';target.autoFit='none';if(m)target.getRange(m.index+m[1].length,m[2].length).replace(fmt(rows[i].score));});
  }
  const redTotal=game?.redTotal??teamTotal(game,'red'), blueTotal=game?.blueTotal??teamTotal(game,'blue');
  const totals=recs.filter(r=>r.bbox?.[1]>450&&r.bbox?.[1]<560&&r.bbox?.[0]>400&&r.bbox?.[0]<850&&/^\d[\d,]*$/.test(String(r.text||'').trim())).sort((a,b)=>a.bbox[0]-b.bbox[0]);
  if(totals[0]){const shape=presentation.resolve(totals[0].id);shape.text.set(fmt(redTotal));shape.fill=redTotal<blueTotal?'rgba(171,20,21,0.4)':RED;}
  if(totals[1]){const shape=presentation.resolve(totals[1].id);shape.text.set(fmt(blueTotal));shape.fill=blueTotal<redTotal?'rgba(15,98,168,0.4)':BLUE;}
  const delta=recs.find(r=>/^\+[\d,]+$/.test(String(r.text||'').trim())&&r.bbox?.[0]>400&&r.bbox?.[0]<850);
  if(delta){
    const shape=presentation.resolve(delta.id);
    shape.name='!!CENTRAL_DELTA';
    shape.text.set(redTotal&&blueTotal?`+${fmt(Math.abs(redTotal-blueTotal))}`:'?');
    if(totals[0]?.bbox&&totals[1]?.bbox&&redTotal!==blueTotal){
      const blueRight=totals[1].bbox[0]+totals[1].bbox[2];
      // The sample is a blue win. Mirror its outer-edge offset for a red
      // win, preserving the original font, height, and textbox insets.
      const edgeOffset=delta.bbox[0]+delta.bbox[2]-blueRight;
      shape.position.left=redTotal>blueTotal?totals[0].bbox[0]-edgeOffset:delta.bbox[0];
      shape.text.alignment=redTotal>blueTotal?'left':'right';
      shape.text.wrap='none';shape.text.autoFit='none';
    }
  }
  await addStdModIcons(presentation,slideNo,red,'red'); await addStdModIcons(presentation,slideNo,blue,'blue');
  if(showImpact){
    const impactBoxes=recs.filter(r=>/^Opp\. Impact/i.test(String(r.text||''))).sort((a,b)=>a.bbox[1]-b.bbox[1]);
    const left=impactBoxes.filter(r=>r.bbox[0]<640), right=impactBoxes.filter(r=>r.bbox[0]>640);
    const loserAverage=loserTeamAverage(game,4);
    for(const [boxes,rows] of [[left,red],[right,blue]]) boxes.slice(0,4).forEach((rec,i)=>{
      const value=relativeScoreIndex(rows[i]?.score,loserAverage);
      const text=value==null?'?':value.toFixed(3), target=presentation.resolve(rec.id).text, source=String(rec.text||'');
      const m=source.match(/(Opp\. Impact\s+)([\d.?]+)/i);if(m){target.getRange(m.index+m[1].length,m[2].length).replace(text);target.getRange(m.index+m[1].length,text.length).color=value!=null&&value<0.75?'#FF3333':value!=null&&value>1.5?'#00CC44':'#FFFFFF';target.getRange(0,'Opp. Impact'.length).replace('RSI');}
    });
    for(const rec of recs.filter(r=>/^Opp\. Impact\s*=/i.test(String(r.text||''))))presentation.resolve(rec.id).text.set('RSI = (Score / Loser Team Avg.)^1.5');
  }
  if(detailIndex==null)return;
  const detail=[red[detailIndex],blue[detailIndex]];
  const statLabels=recs.filter(r=>/^GREAT:\s*\nOK:\s*\nMEH:\s*\nMISS:/i.test(String(r.text||'').trim())).sort((a,b)=>a.bbox[0]-b.bbox[0]);
  const values=recs.filter(r=>String(r.text||'').trim().split(/\s*\n\s*/).length===4&&String(r.text||'').trim().split(/\s*\n\s*/).every(v=>/^[\d,?]+$/.test(v))).sort((a,b)=>a.bbox[0]-b.bbox[0]);
  values.slice(0,2).forEach((rec,i)=>{const row=detail[i];presentation.resolve(rec.id).name=`!!STD_JUDGEMENTS_${slideNo}_${i}`;presentation.resolve(rec.id).text.set(['great','ok','meh','miss'].map(k=>q(statValue(row,k))).join('\n'));});
  statLabels.forEach((rec,i)=>presentation.resolve(rec.id).name=`!!STD_JUDGEMENT_LABELS_${slideNo}_${i}`);
  const combos=recs.filter(r=>/^MAX COMBO/i.test(String(r.text||''))).sort((a,b)=>a.bbox[0]-b.bbox[0]);
  const accs=recs.filter(r=>/^ACCURACY/i.test(String(r.text||''))).sort((a,b)=>a.bbox[0]-b.bbox[0]);
  combos.forEach((rec,i)=>{const row=detail[i],source=String(rec.text||''),m=source.match(/(MAX COMBO\s+)([\d,?]+)/i);if(m)presentation.resolve(rec.id).text.getRange(m.index+m[1].length,m[2].length).replace(fmt(row.maxCombo));});
  accs.forEach((rec,i)=>{const row=detail[i],source=String(rec.text||''),m=source.match(/(ACCURACY\s+)([\d.?]+%?)/i);if(m)presentation.resolve(rec.id).text.getRange(m.index+m[1].length,m[2].length).replace(row.accuracy==null?'?':`${(Number(row.accuracy)*100).toFixed(2)}%`);});
}

async function setStdMapInfo(presentation, slideNo, map, game) {
  const b=game?.displayBeatmap||game?.beatmap||{}, set=b.beatmapset||{}, recs=await records(presentation,'textbox',slideNo);
  const stat = value => value == null ? '?' : Number(Number(value).toFixed(2)).toString();
  const version=String(b.version||'').replace(/^\[[^\]]+\]\s*/,'');
  const title=b.deleted?'?':(set.artist&&set.title?`${set.artist} - ${set.title} [${version||'?'}]`:'?');
  const mapper=set.creator||b.creator||'?';
  const length=b.total_length?`${Math.floor(b.total_length/60)}:${String(b.total_length%60).padStart(2,'0')}`:'?';
  for(const rec of recs){const source=String(rec.text||''),box=rec.bbox||[],target=presentation.resolve(rec.id).text;
    if(box[0]>650&&box[0]<900&&box[1]>90&&box[1]<230&&/^(?:NM|HD|HR|DT|FM|TB)\d*$/i.test(source.trim())){target.set(map.code);continue;}
    if(box[0]>350&&box[0]<950&&box[1]>180&&box[1]<360&&/\nBy\s/i.test(source)) {
      const by=source.search(/\nBy\s/i);
      target.getRange(by+1,source.length-by-1).replace(`By ${mapper}`);
      target.getRange(0,by).replace(title);
      target.wrap='square';target.autoFit='none';continue;
    }
    if(source.includes('LENGTH')&&source.includes('STAR RATING')){
      for(const [pattern,value] of [[/(STAR RATING\s+)([^\n]+)/,b.difficulty_rating==null?'?':Number(b.difficulty_rating).toFixed(2)],[/(LENGTH\s+)([^\n]+)/,length]]){
        const match=source.match(pattern);if(match)target.getRange(match.index+match[1].length,match[2].length).replace(value);
      }
      continue;
    }
    if(source.includes('BPM')&&source.includes('Combos')){
      const newline=source.indexOf('\n');if(newline>=0)target.getRange(newline,source.length-newline).replace('');
      const match=source.match(/^(\s*)(\S+)(?=\s+BPM)/);if(match)target.getRange(match[1].length,match[2].length).replace(stat(b.bpm));
      continue;
    }
    if(source.includes('CS')&&source.includes('/ AR')&&source.includes('/ OD')){
      const changes=[...source.matchAll(/\b(CS|AR|OD)\s+([\d.?*]+)/g)].map(match=>({start:match.index+match[0].length-match[2].length,length:match[2].length,value:stat(({CS:b.cs,AR:b.ar,OD:b.accuracy})[match[1]])}));
      for(const change of changes.reverse())target.getRange(change.start,change.length).replace(change.value);
    }
  }
}

async function setStdBpInfo(presentation,slideNo,input){
  const recs=await records(presentation,'textbox',slideNo);
  const rollLabel=recs.find(r=>/^Roll$/i.test(String(r.text||'').trim())&&r.bbox?.[1]>570);
  if(rollLabel){const cx=rollLabel.bbox[0]+rollLabel.bbox[2]/2,cy=rollLabel.bbox[1]+rollLabel.bbox[3]/2,candidates=recs.filter(r=>Math.abs((r.bbox?.[0]+r.bbox?.[2]/2)-cx)<35&&r.id!==rollLabel.id);const top=candidates.filter(r=>r.bbox[1]<cy).sort((a,b)=>b.bbox[1]-a.bbox[1])[0],bottom=candidates.filter(r=>r.bbox[1]>cy).sort((a,b)=>a.bbox[1]-b.bbox[1])[0];if(top)presentation.resolve(top.id).text.set(q(input.redRoll));if(bottom)presentation.resolve(bottom.id).text.set(q(input.blueRoll));}
  const top=recs.filter(r=>r.bbox?.[0]>320&&r.bbox?.[0]<540&&r.bbox?.[1]>550&&r.bbox?.[1]<615&&!/^Ban$/i.test(String(r.text||'').trim())).sort((a,b)=>a.bbox[0]-b.bbox[0]);
  const bottom=recs.filter(r=>r.bbox?.[0]>320&&r.bbox?.[0]<540&&r.bbox?.[1]>650&&r.bbox?.[1]<710).sort((a,b)=>a.bbox[0]-b.bbox[0]);
  const count=owcBanCount(input);
  for(const [team,cells,values] of [['RED',top,[input.redBan,input.redBan2]],['BLUE',bottom,[input.blueBan,input.blueBan2]]]){
    cells.forEach((rec,i)=>{
      const shape=presentation.resolve(rec.id);
      if(i>=count){shape.delete();return;}
      shape.name=`!!BP_${team}_BAN_${i+1}`;shape.text.set(q(values[i]));
    });
  }
  const banLabel=recs.find(r=>/^Ban$/i.test(String(r.text||'').trim())&&r.bbox?.[1]>570);
  if(banLabel){
    const shape=presentation.resolve(banLabel.id);shape.name='!!BP_BAN_LABEL';
    if(count===1&&bottom[0]){
      // The supplied BO9 sample keeps red at the left and blue at the right
      // of the narrower Ban label. Remove the second pair before centering
      // the complete BP + picks rail, so no empty second column remains.
      shape.position.width=bottom[0].bbox[0]+bottom[0].bbox[2]-banLabel.bbox[0];
    }
  }
}

async function setStdWinnerSlide(presentation, slideNo, {redWins,blueWins,input}) {
  const slide=presentation.slides.items[slideNo-1],redWon=redWins>blueWins;
  const winner=redWon?input.redTeam:input.blueTeam,color=redWon?RED:BLUE,seed=redWon?input.redSeed:input.blueSeed;
  // Match the supplied sample's final result page: score at left, WINNER and
  // team/country/seed at right. All fields remain independent editable text.
  const add=(name,text,frame,size,{fill='none',textColor='#FFFFFF',typeface='Torus',alignment='left'}={})=>{
    const shape=slide.shapes.add({name,geometry:'rect',position:frame,fill,line:{fill:'none'}});
    shape.text.set(text);shape.text.typeface=typeface;shape.text.fontSize=fontPt(size);shape.text.color=textColor;shape.text.alignment=alignment;shape.text.verticalAlignment='middle';shape.text.wrap='none';shape.text.autoFit='none';shape.position=frame;
    return shape;
  };
  add('!!STD_FINAL_SCORE',`${redWins} - ${blueWins}`,{left:251.17,top:266.95,width:360,height:138.94},80,{typeface:'Torus Bold'});
  add('!!STD_WINNER_HEADING','WINNER',{left:708.97,top:193.19,width:380,height:106.63},60,{typeface:'Torus Bold'});
  add('!!STD_WINNER_TEAM',redWon?'TEAM RED':'TEAM BLUE',{left:721.23,top:307.46,width:175.47,height:43.27},23,{fill:color,alignment:'center'});
  add('!!STD_WINNER_COUNTRY',winner,{left:721.23,top:359.26,width:Math.max(180,[...winner].length*27+20),height:67.8},40,{fill:'#FFFFFF',textColor:'#000000'});
  add('!!STD_WINNER_SEED',String(seed),{left:721.23,top:439.8,width:Math.max(89.33,String(seed).length*25+20),height:48.87},28,{fill:'#FFFFFF',textColor:'#000000'});
}

async function generateStdDeck({ templatePath, outputPath, input, pool, games, qaDir, onProgress }) {
  const progress=(f,m)=>onProgress?.(Math.max(0,Math.min(1,f)),m);
  progress(0.01,'正在载入 OWC 模板…');
  const presentation=await openTemplate(templatePath);
  const originals=slideList(presentation), selected=[originals[1].duplicate(),originals[2].duplicate()];
  const gameCount=Math.min(games.length,Number(input.bestOf));
  for(let i=0;i<gameCount;i++)for(let j=0;j<7;j++)selected.push(originals[3+j].duplicate());
  selected.push(originals[10].duplicate(),originals[10].duplicate());
  originals.forEach(s=>s.delete());selected.forEach((s,i)=>s.moveTo(i));
  progress(.18,`已载入 ${selected.length} 页，保留模板原始字体和格式…`);
  const common=[['osu! World Cup 2025',input.competitionName],['Grand Finals',input.round],['United States',input.redTeam],['Poland',input.blueTeam],['#2',input.redSeed],['#1',input.blueSeed],['Bracket Reset | Best of 13 | Sun 14 Dec @20:10(UTC+0)',`${input.bracket} | Best of ${input.bestOf} | ${input.matchTime}`]];
  for(let slideNo=2;slideNo<=selected.length-1;slideNo++){await replaceOnSlide(presentation,slideNo,common);await setTeamNames(presentation,slideNo,input);await setSeedBoxes(presentation,slideNo,input);await setRoundBoxWidth(presentation,slideNo,input.round);}
  const winsNeeded=(Number(input.bestOf)+1)/2;let redWins=0,blueWins=0;
  for(let i=0;i<gameCount;i++){
    const start=3+i*7,game=games[i],map=game?.poolMap||pool.find(m=>Number(m.beatmapId)===Number(game?.beatmapId))||{code:'?'};
    const isTb=String(map.code).toUpperCase()==='TB',picker=i%2===0?input.firstPicker:(input.firstPicker==='red'?'blue':'red'),pickerName=isTb?'Tiebreaker':(picker==='red'?input.redTeam:input.blueTeam);
    await setPickLabel(presentation,start,pickerName);await setStdMapInfo(presentation,start,map,game);
    await replaceCover(presentation,start,game?.beatmap);await stylePick(presentation,start,map.code,picker);
    const redBefore=redWins,blueBefore=blueWins,redTotal=game?.redTotal??teamTotal(game,'red'),blueTotal=game?.blueTotal??teamTotal(game,'blue');
    if(game?.winner==='red'||(!game?.winner&&redTotal>blueTotal))redWins++;else if(game?.winner==='blue'||(!game?.winner&&blueTotal>redTotal))blueWins++;
    for(let j=1;j<7;j++){const slideNo=start+j;await setStdScoreData(presentation,slideNo,game,j>=2&&j<=5?j-2:null,j===6);await setStdMapInfo(presentation,slideNo,map,game);await removeMapVisual(presentation,slideNo);}
    for(let j=0;j<7;j++){await setStdBpInfo(presentation,start+j,input);await setScoreBoxes(presentation,start+j,winsNeeded,j===0?redBefore:redWins,j===0?blueBefore:blueWins);await setProgressBar(presentation,start+j,games,i,input.firstPicker,j>0);}
    progress(.18+.68*(i+1)/Math.max(1,gameCount),`已完成第 ${i+1}/${gameCount} 张赛图的七页循环…`);
  }
  await setStdWinnerSlide(presentation,selected.length-1,{redWins,blueWins,input});
  if(qaDir)await presentation.writeInspection(qaDir);
  progress(.88,'正在导出可编辑 PPTX…');await saveTemplate(presentation,outputPath);progress(.96,'正在写入平滑切换动效…');await restoreSampleTransitions(outputPath,[input.redTeam,input.blueTeam]);progress(1,'生成完成。');
  return{slideCount:selected.length,redWins,blueWins,winner:redWins>blueWins?input.redTeam:input.blueTeam};
}

export async function generateDeck({ templatePath, outputPath, input, pool, games, qaDir, onProgress = null }) {
  input=normalizeTournamentInput(input);
  requireTournamentTemplate(input);
  for(const game of games)for(const team of ['red','blue']){
    if((game.scores||[]).filter(row=>row.team===team).length>input.playersPerTeam)throw new Error(`${input.tournamentType} 固定为 ${input.playersPerTeam}v${input.playersPerTeam}，对局 ${game.id||'?'} 的 ${team} 方人数超出赛制，请核对比赛。`);
  }
  if (input.tournamentType === 'OWC') return generateStdDeck({ templatePath, outputPath, input, pool, games, qaDir, onProgress });
  const progress = (fraction, message) => onProgress?.(Math.max(0,Math.min(1,fraction)), message);
  progress(0.01, '正在载入 PPT 模板…');
  const presentation = await openTemplate(templatePath);
  const originals = slideList(presentation);
  const selected = [originals[0].duplicate(), originals[1].duplicate()];
  const gameCount = Math.min(games.length, Number(input.bestOf));
  for (let i = 0; i < gameCount; i++) {
    // Every played map uses the first six-slide cycle as the canonical
    // template. Later cycles in the supplied PPT contain small, accidental
    // geometry and layer-order differences; all per-game state is generated
    // below, so inheriting those inconsistent copies is unnecessary.
    const cycleStart = 2;
    for (let j = 0; j < 6; j++) selected.push(originals[cycleStart + j].duplicate());
  }
  selected.push(originals[44].duplicate(), originals[45].duplicate());
  originals.forEach(s => s.delete()); selected.forEach((s, i) => s.moveTo(i));
  progress(0.18, `已创建 ${selected.length} 页，保留模板原始字体和格式…`);

  const common = [
    ['osu!mania 4K World Cup 2026', input.competitionName], ['Round of 32', input.round],
    ['Vietnam', input.redTeam], ['Philippines', input.blueTeam], ['#16', input.redSeed], ['#17', input.blueSeed],
    ['Winners Bracket | Best of 9 | Fri, 21 Aug @08:00(UTC+0)', `${input.bracket} | Best of ${input.bestOf} | ${input.matchTime}`],
  ];
  const winsNeeded = (Number(input.bestOf) + 1) / 2;
  let redWins = 0, blueWins = 0;
  for (let slideNo = 2; slideNo <= selected.length - 1; slideNo++) { await replaceOnSlide(presentation, slideNo, common); await setTeamNames(presentation, slideNo, input); await setSeedBoxes(presentation, slideNo, input); await setRoundBoxWidth(presentation, slideNo, input.round); }
  await replaceOnSlide(presentation, 2, [['osu!mania', input.modeLabel]]);

  for (let i = 0; i < gameCount; i++) {
    const start = 3 + i * 6;
    const game = games[i];
    const map = game?.poolMap || pool.find(m => Number(m.beatmapId) === Number(game?.beatmapId)) || { code: '?', title: '?' };
    const isTb = String(map.code).trim().toUpperCase() === 'TB';
    const picker = i % 2 === 0 ? input.firstPicker : (input.firstPicker === 'red' ? 'blue' : 'red');
    const pickerName = isTb ? 'Tiebreaker' : (picker === 'red' ? input.redTeam : input.blueTeam);
    await setPickLabel(presentation,start,pickerName);
    await setMapInfo(presentation,start,map,game);
    // Build the visual component once from the Pick page: background image and
    // its top-right map-code label. Their relative offset, crop, dimensions,
    // and z-order are the canonical source for every score page in this map's
    // six-slide cycle.
    await replaceCover(presentation, start, game?.beatmap);
    await stylePick(presentation,start,map.code,picker);
    const redWinsBefore=redWins, blueWinsBefore=blueWins;
    const redTotal = game?.redTotal ?? teamTotal(game, 'red'), blueTotal = game?.blueTotal ?? teamTotal(game, 'blue');
    if (game?.winner === 'red' || (!game?.winner && redTotal && blueTotal && redTotal > blueTotal)) redWins++;
    else if (game?.winner === 'blue' || (!game?.winner && redTotal && blueTotal && blueTotal > redTotal)) blueWins++;
    for (let j = 1; j < 6; j++) {
      const scoreSlideNo = start + j;
      await setScoreData(presentation,scoreSlideNo,game,j>=2&&j<=4?j-2:null);
      await setMapInfo(presentation,scoreSlideNo,map,game);
      // Only the Pick page carries cover art and the pool code. Score/detail
      // pages keep the map text and metrics but intentionally omit the image.
      await removeMapVisual(presentation,scoreSlideNo);
    }
    for (let j = 0; j < 6; j++) { await setBpInfo(presentation,start+j,input); await setScoreBoxes(presentation, start + j, winsNeeded, j===0?redWinsBefore:redWins, j===0?blueWinsBefore:blueWins); await setProgressBar(presentation,start+j,games,i,input.firstPicker,j>0); }
    progress(0.18 + 0.68 * (i + 1) / Math.max(1,gameCount), `已完成第 ${i + 1}/${gameCount} 张赛图的六页循环…`);
  }
  const winner = redWins > blueWins ? input.redTeam : input.blueTeam;
  await setWinnerSlide(presentation, selected.length - 1, { redWins, blueWins, input });

  if (qaDir) await presentation.writeInspection(qaDir);
  progress(0.88, '正在导出可编辑 PPTX…');
  await saveTemplate(presentation, outputPath);
  progress(0.96, '正在写入平滑切换动效…');
  await restoreSampleTransitions(outputPath, [input.redTeam, input.blueTeam]);
  progress(1, '生成完成。');
  return { slideCount: selected.length, redWins, blueWins, winner };
}
