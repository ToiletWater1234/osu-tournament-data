import { firstPickerFromRolls, normalizeRoll } from './roll.js';
import { tournaments, resolveTournament } from './tournaments.js';
import { startProgressPolling } from './generation-progress.js';
let tournamentType='',modeLabel='',games=[],automaticPicks=[],poolCsv='',pendingBp={},analyzedKey='';
function isStd(){return modeLabel==='osu!'}
function usesTwoStdBans(){return isStd()&&/(quarter|semi|final|grand|bracket reset)/i.test(form.elements.round?.value||'')}
function updateModeFields(){const std=isStd(),two=usesTwoStdBans(),protect=tournamentType==='MWC4k';document.querySelectorAll('.std-only').forEach(x=>x.hidden=!std);document.querySelectorAll('.mania-protect').forEach(x=>x.hidden=!protect);document.querySelectorAll('.std-second-ban').forEach(x=>x.hidden=!std||!two);for(const name of ['redProtect','blueProtect'])form.elements[name].required=protect;for(const name of ['stdFirstPicker','stdFirstBan'])form.elements[name].required=std;for(const name of ['redBan2','blueBan2'])form.elements[name].required=two;}
const modeBox=document.querySelector('#modeButtons');for(const profile of tournaments){const b=document.createElement('button');b.type='button';b.textContent=profile.id;b.dataset.tournament=profile.id;b.onclick=()=>{tournamentType=profile.id;modeLabel=profile.modeLabel;analyzedKey='';games=[];automaticPicks=[];document.querySelector('#autoPicks').textContent='比赛类型已更改，请重新分析 mplink。';[...modeBox.children].forEach(x=>x.classList.toggle('active',x===b));document.querySelector('#poolFile').disabled=false;document.querySelector('#tournamentInfo').textContent=`${profile.id} · ${profile.playersPerTeam}v${profile.playersPerTeam}${profile.ready?'':' · 专用赛制模板待配置，暂不支持生成'}`;document.querySelector('#generate').disabled=!profile.ready;document.querySelector('#poolStatus').textContent=poolCsv?'图池已读取，可继续填写比赛信息。':'比赛类型已选择，现在请上传图池 CSV。';updateModeFields();updateBpOptions();order()};modeBox.append(b)}
const form=document.querySelector('#form'),status=document.querySelector('#importStatus'),result=document.querySelector('#result');
const progressWrap=document.createElement('div');progressWrap.className='generation-progress';progressWrap.hidden=true;progressWrap.innerHTML='<div class="progress-track"><div class="progress-fill"></div></div><div class="progress-copy"><output>等待生成…</output><strong>0%</strong></div>';document.querySelector('.submit').insertBefore(progressWrap,result);
const progressFill=progressWrap.querySelector('.progress-fill'),progressText=progressWrap.querySelector('output'),progressPercent=progressWrap.querySelector('strong');
const progressStyle=document.createElement('style');progressStyle.textContent='.generation-progress{max-width:720px;margin:24px auto 0;text-align:left}.progress-track{height:14px;background:#242429;border:1px solid var(--line);overflow:hidden}.progress-fill{height:100%;width:0;background:linear-gradient(90deg,var(--red),var(--cream));transition:width .25s ease}.progress-copy{display:flex;justify-content:space-between;gap:16px;margin-top:9px;color:var(--muted)}.progress-copy strong{color:var(--cream);white-space:nowrap}';document.head.append(progressStyle);
function showProgress(percent,message){const value=Math.max(0,Math.min(100,Math.round(Number(percent)||0)));if(value<=2)progressFill.style.background='';progressWrap.hidden=false;progressFill.style.width=`${value}%`;progressPercent.textContent=`${value}%`;if(message)progressText.textContent=message}
form.addEventListener('submit',async e=>{
  e.preventDefault();e.stopImmediatePropagation();
  if(!modeLabel){result.textContent='请先选择比赛类型。';return}
  if(!poolCsv){result.textContent='请先读取图池 CSV。';return}
  const btn=document.querySelector('#generate');btn.disabled=true;
  let stopPolling=null;
  try{
    showProgress(1,'正在检查 mplink 分析状态…');
    if(analyzedKey!==analysisKey()){result.textContent='尚未分析当前 mplink，正在自动分析…';await analyzeMatch()}
    const generationId=globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random()}`;
    showProgress(2,'分析完成，正在启动生成任务…');
    let completedResult=null,failureMessage='';
    stopPolling=startProgressPolling(generationId,{
      onState:state=>{if(state.percent>0)showProgress(state.percent,state.message);if(state.status==='complete')completedResult=state.result;if(state.status==='failed')failureMessage=state.message;},
      onUnavailable:()=>{progressText.textContent='暂时无法获取进度，正在重连本地服务；生成请求仍在等待。';}
    });
    let data;
    try{
      const response=await fetch('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...values(),generationId})});
      data=await response.json();if(!response.ok)throw new Error(data.error||failureMessage||'生成失败');
    }catch(error){if(completedResult)data=completedResult;else throw new Error(failureMessage||error.message);}
    stopPolling();showProgress(100,'生成完成。');
    result.innerHTML=`完成：${data.slideCount} 页，${data.redWins}-${data.blueWins}。<a href="${data.download}">下载 PPTX</a><br>选手、比分、判定与谱面 ID：mplink；谱面资料：osu! 官网 API。${data.warning?`<br>${data.warning}`:''}`;
  }catch(error){progressFill.style.background='var(--red)';showProgress(Number(progressPercent.textContent.replace('%',''))||0,`生成失败：${error.message}`);result.textContent=`生成失败：${error.message}`;}
  finally{stopPolling?.();btn.disabled=!resolveTournament(tournamentType)?.ready;}
},true);
const oauthStatus=document.querySelector('#oauthStatus');async function oauthState(){try{const d=await(await fetch('/api/oauth')).json();oauthStatus.textContent=d.configured?` 已配置 Client ID ${d.clientId}`:' 尚未配置';}catch{}}oauthState();
document.querySelector('#saveOauth').onclick=async()=>{oauthStatus.textContent=' 正在验证…';try{const r=await fetch('/api/oauth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientId:document.querySelector('#clientId').value,clientSecret:document.querySelector('#clientSecret').value})});const d=await r.json();if(!r.ok)throw new Error(d.error);document.querySelector('#clientSecret').value='';oauthStatus.textContent=` 已保存并验证 Client ID ${d.clientId}`;}catch(e){oauthStatus.textContent=` 配置失败：${e.message}`}};
const weekdays=['','Mon','Tue','Wed','Thu','Fri','Sat','Sun'],months=['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function csvRows(text){const rows=[];let row=[],field='',quoted=false;for(let i=0;i<text.length;i++){const ch=text[i];if(ch==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++}else quoted=!quoted}else if(ch===','&&!quoted){row.push(field);field=''}else if((ch==='\n'||ch==='\r')&&!quoted){if(ch==='\r'&&text[i+1]==='\n')i++;row.push(field);field='';if(row.some(v=>v.trim()))rows.push(row);row=[]}else field+=ch}if(field||row.length){row.push(field);rows.push(row)}return rows}
function updateBpOptions(){const names=['redProtect','blueProtect','redBan','blueBan','redBan2','blueBan2'],selects=names.map(n=>form.elements[n]);const rows=csvRows(poolCsv);const headers=(rows.shift()||[]).map(x=>x.trim().toLowerCase());const codeIndex=headers.findIndex(x=>x==='id'||x==='code');const codes=[...new Set(rows.map(r=>(r[codeIndex]||'').trim()).filter(Boolean))];for(let i=0;i<selects.length;i++){const select=selects[i],name=names[i],old=pendingBp[name]||select.value;select.replaceChildren(new Option(codes.length?'请选择图池内谱面':'请先上传图池',''));for(const code of codes)select.add(new Option(code,code));select.disabled=!codes.length;if(codes.includes(old))select.value=old}}
const pad=n=>String(Number(n)).padStart(2,'0');
function formatTime(x){const wd=weekdays[Number(x.weekday)]||'?',mo=months[Number(x.month)]||'?',tz=Number(x.timezone);return `${wd}, ${pad(x.day)} ${mo} @${pad(x.hour)}:${pad(x.minute)}(UTC${tz>=0?'+':''}${Number.isFinite(tz)?tz:'?'})`}
function values(){const x=Object.fromEntries(new FormData(form));x.tournamentType=tournamentType;x.modeLabel=modeLabel;x.bestOf=Number(x.bestOf);x.redRoll=normalizeRoll(x.redRoll);x.blueRoll=normalizeRoll(x.blueRoll);x.firstPicker=isStd()?x.stdFirstPicker:firstPickerFromRolls(x.redRoll,x.blueRoll);x.matchTime=formatTime(x);x.poolCsv=poolCsv;return x}
function timePreview(){const x=Object.fromEntries(new FormData(form)),complete=['weekday','month','day','hour','minute','timezone'].every(k=>x[k]!==''&&x[k]!==undefined);document.querySelector('#timePreview').textContent=complete?`PPT 显示：${formatTime(x)}`:'输入后将显示为：Fri, 21 Aug @08:00(UTC+8)'}
function order(){const x=values(),profile=resolveTournament(tournamentType);if(!profile){document.querySelector('#bpOrder').textContent='';return}if(!profile.ready){document.querySelector('#bpOrder').textContent=`${profile.id} 固定为 ${profile.playersPerTeam}v${profile.playersPerTeam}，专用赛制模板待配置。`;return}if(isStd()){const pick=x.firstPicker==='red'?x.redTeam:x.blueTeam,ban=x.stdFirstBan==='red'?x.redTeam:x.blueTeam,otherBan=x.stdFirstBan==='red'?x.blueTeam:x.redTeam;document.querySelector('#bpOrder').textContent=usesTwoStdBans()?`OWC BP：${ban} Ban → ${otherBan} Ban ×2 → ${ban} Ban；${pick||'待选择'}首选，之后两队轮流选图。`:`OWC BP：${ban||'待选择'}先 Ban，双方各 Ban 1 张；${pick||'待选择'}首选，之后两队轮流选图。`;return}const big=x.firstPicker==='red'?x.redTeam:x.blueTeam,small=x.firstPicker==='red'?x.blueTeam:x.redTeam;document.querySelector('#bpOrder').textContent=`BP 顺序：${big} Protect → ${small} Protect → ${small} Ban → ${big} Ban → ${big} 首选，之后轮流选图`}
form.addEventListener('input',e=>{if(e.target?.name==='mplink'||e.target?.name==='bestOf')analyzedKey='';if(e.target?.name==='round'){updateModeFields();updateBpOptions()}order();timePreview()});order();timePreview();
document.querySelector('#poolFile').onchange=async e=>{poolCsv=e.target.files[0]?await e.target.files[0].text():'';games=[];automaticPicks=[];analyzedKey='';updateBpOptions();document.querySelector('#postPool').disabled=!poolCsv;document.querySelector('#poolStatus').textContent=poolCsv?`图池已读取：${e.target.files[0].name}。现在可以继续填写比赛信息。`:'比赛类型已选择，现在请上传图池 CSV。';document.querySelector('#autoPicks').textContent=poolCsv?'图池已载入，请选择 Protect/Ban 并读取 mplink。':'请上传图池 CSV。';if(poolCsv)document.querySelector('#matchInfoFile').focus()};
function setMode(value,competitionName=''){const profile=resolveTournament(value,competitionName);const hit=[...modeBox.children].find(b=>b.dataset.tournament===profile?.id);if(hit)hit.click()}
function parseMatchInfoCsv(text){
  const rows=csvRows(text),data={},duplicates={};
  for(const row of rows){const key=String(row[0]||'').replace(/^\uFEFF/,'').trim().toLowerCase(),value=row.slice(1).join(',').trim();if(!key)continue;if(data[key]!==undefined)(duplicates[key]??=[]).push(value);else data[key]=value}
  if(!data.red_ban&&duplicates.red_protect?.length)data.red_ban=duplicates.red_protect.at(-1);
  return data;
}
function setField(name,value){if(value===undefined||value==='')return;const field=form.elements[name];if(field)field.value=String(value)}
function normalizeMplink(value){const text=String(value||'').trim();return /^\d+$/.test(text)?`https://osu.ppy.sh/community/matches/${text}`:text}
function applyMatchInfo(data){
  const map={tournament_name:'competitionName',round:'round',bracket:'bracket',best_of:'bestOf',red_team:'redTeam',red_seed:'redSeed',blue_team:'blueTeam',blue_seed:'blueSeed',red_roll:'redRoll',blue_roll:'blueRoll',mplink:'mplink'};
  for(const [key,name] of Object.entries(map))setField(name,name==='mplink'?normalizeMplink(data[key]):data[key]);
  pendingBp={redProtect:data.red_protect,blueProtect:data.blue_protect,redBan:data.red_ban,blueBan:data.blue_ban,redBan2:data.red_ban_2,blueBan2:data.blue_ban_2};updateBpOptions();
  setField('stdFirstPicker',data.first_pick_team);
  setField('stdFirstBan',data.first_ban_team);
  const match=String(data.match_time||'').match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s*(\d{1,2})\s+([A-Za-z]{3})\s+@(\d{1,2}):(\d{2})\(UTC([+-]?\d+(?:\.5)?)\)$/i);
  if(match){setField('weekday',weekdays.findIndex(x=>x.toLowerCase()===match[1].toLowerCase()));setField('day',Number(match[2]));setField('month',months.findIndex(x=>x.toLowerCase()===match[3].toLowerCase()));setField('hour',Number(match[4]));setField('minute',Number(match[5]));setField('timezone',Number(match[6]));}
  const title=String(data.tournament_name||''),explicit=String(data.tournament_type||data.tournament||data.mode||'').trim();
  const inferred=/mania.*7\s*k|mwc\s*7\s*k/i.test(title)?'MWC7k':/mania|mwc\s*4\s*k/i.test(title)?'MWC4k':/catch|\bcwc\b/i.test(title)?'CWC':/taiko|\btwc\b/i.test(title)?'TWC':/osu!\s*world cup|\bowc\b/i.test(title)?'OWC':'';
  if(explicit||inferred)setMode(explicit||inferred,title);
  order();timePreview();
}
document.querySelector('#matchInfoFile').onchange=async e=>{const out=document.querySelector('#matchInfoStatus');try{if(!e.target.files[0])return;const data=parseMatchInfoCsv(await e.target.files[0].text());applyMatchInfo(data);out.textContent='比赛信息 CSV 已填写到表单；请上传图池，并从 mplink 读取正式比赛数据。';}catch(error){out.textContent=`比赛信息 CSV 读取失败：${error.message}`}};
const analysisKey=()=>`${tournamentType}|${form.mplink.value.trim()}|${Number(form.bestOf.value)}|${poolCsv}`;
async function analyzeMatch(){
  if(!poolCsv)throw new Error('请先上传图池 CSV。');
  if(!form.mplink.value.trim())throw new Error('请先输入 mplink。');
  status.textContent=' 正在从 osu! 官网读取全部对局并逐局核对 beatmap ID…';
  try{const r=await fetch('/api/import-match',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tournamentType,modeLabel,mplink:form.mplink.value,bestOf:Number(form.bestOf.value),poolCsv})});const data=await r.json();if(!r.ok)throw new Error(data.error);games=data.games||[];automaticPicks=data.picks||[];analyzedKey=analysisKey();const ignored=data.audit?.ignoredBeatmapIds||[],empty=data.audit?.emptyGameEvents||0;document.querySelector('#autoPicks').textContent=automaticPicks.join(' → ');status.textContent=` 已读取有效记录 ${data.audit?.roomGames??'?'} 局，正式赛 ${automaticPicks.length} 图${empty?`，另排除 ${empty} 个无成绩开局事件`:''}，累计比分 ${data.score}${data.complete?'，已决出胜负':'，尚未达到赛点'}${ignored.length?`；跳过的非图池 ID：${ignored.join(', ')}`:''}。`;return data;}catch(e){analyzedKey='';games=[];automaticPicks=[];document.querySelector('#autoPicks').textContent='未能判定选图顺序。';status.textContent=` 读取失败：${e.message}`;throw e;}
}
document.querySelector('#importMatch').onclick=()=>analyzeMatch().catch(()=>{});
form.onsubmit=async e=>{e.preventDefault();if(!modeLabel){result.textContent='请先选择比赛类型。';return}if(!poolCsv){result.textContent='请先读取图池 CSV。';return}const btn=document.querySelector('#generate');btn.disabled=true;try{if(analyzedKey!==analysisKey()){result.textContent='尚未分析当前 mplink，正在自动分析…';await analyzeMatch();}result.textContent='分析完成，正在从 mplink 重新读取正式数据并生成…';const r=await fetch('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(values())});const data=await r.json();if(!r.ok)throw new Error(data.error);result.innerHTML=`完成：${data.slideCount} 页，${data.redWins}-${data.blueWins}。<a href="${data.download}">下载 PPTX</a><br>选手、比分、判定与谱面 ID：mplink；谱面资料：osu! 官网 API。${data.warning?`<br>${data.warning}`:''}`;}catch(e){result.textContent=`生成失败：${e.message}`}finally{btn.disabled=false}};
const shutdownButton=document.querySelector('#shutdownService'),shutdownStatus=document.querySelector('#shutdownStatus');shutdownButton.onclick=async()=>{if(!confirm('确定要关闭本地服务吗？关闭时会清理输出和缓存，之后需重新启动程序。'))return;shutdownButton.disabled=true;shutdownStatus.textContent='正在清理缓存并关闭…';try{await fetch('/api/shutdown',{method:'POST'});}catch{}shutdownStatus.textContent='本地服务已关闭，可以关闭此页面。';};
