import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns';
import { normalizePool } from './lib/csv.mjs';
import { fetchMatch, fetchMatchApi, fetchBeatmap, fetchModdedBeatmap, extractGames, selectPoolGames } from './lib/osu.mjs';
import { runGenerationJob } from './lib/generation-job.mjs';
import { OAuthStore } from './lib/oauth.mjs';
import { normalizeTournamentInput, requireTournamentTemplate, owcBanCount } from './public/tournaments.js';
import { prepareSeries } from './public/match-data.js';
import { validateEditedGames } from './lib/match-edits.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
dns.setDefaultResultOrder('ipv4first');
const assets = path.join(root, 'assets');
const dataRoot = root;
const outputs = path.join(dataRoot, 'outputs');
await fs.mkdir(outputs, { recursive: true });
await fs.mkdir(path.join(dataRoot,'.tmp'), { recursive: true });
await fs.writeFile(path.join(dataRoot,'.tmp','server.pid'), String(process.pid));
const oauth = new OAuthStore(path.join(dataRoot,'.local'));
await oauth.load().catch(()=>{});
const types = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.csv':'text/csv; charset=utf-8', '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation' };
const beatmapCache = new Map();
const moddedBeatmapCache = new Map();
const generationProgress = new Map();
function setGenerationProgress(id, percent, message, status = 'running', result = null) {
  if (!id) return;
  generationProgress.set(id, { percent:Math.max(0,Math.min(100,Math.round(percent))), message, status, result, updatedAt:Date.now() });
}

async function body(req) { const chunks=[]; for await (const c of req) chunks.push(c); return Buffer.concat(chunks); }
function json(res, status, value) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); }
function safeName(s) { return String(s || 'osu-match').replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 80); }
async function loadMatch(mplink) {
  let apiError;
  try { return await fetchMatchApi(mplink, await oauth.accessToken()); } catch (error) { apiError = error; }
  try { return await fetchMatch(mplink); } catch (pageError) { throw new Error(`无法读取比赛数据。OAuth/API：${apiError.message}；公开比赛页：${pageError.message}`); }
}
async function officialPoolGames(mplink, pool) {
  const payload = await loadMatch(mplink);
  const allGames = extractGames(payload);
  const selected = selectPoolGames(allGames, pool);
  const poolIds = new Set(pool.map(map => map.beatmapId));
  const scored = allGames.filter(game => game.scores?.length);
  const ignoredBeatmapIds = [...new Set(scored.filter(game => game.beatmapId && !poolIds.has(game.beatmapId)).map(game => game.beatmapId))];
  return { payload, games: selected, audit: { roomGames: scored.length, emptyGameEvents: allGames.length - scored.length, ignoredBeatmapIds } };
}

async function hydrateGames(games, modeLabel, onProgress) {
  const token = await oauth.accessToken();
  for (const [gameIndex, game] of games.entries()) {
    if (!game.beatmapId) game.beatmap = { id: null, deleted: true, beatmapset: {} };
    else if(beatmapCache.has(game.beatmapId))game.beatmap=beatmapCache.get(game.beatmapId);
    else try { game.beatmap = await fetchBeatmap(game.beatmapId, token);beatmapCache.set(game.beatmapId,game.beatmap); }
    catch(error){
      if(error.status!==404)throw new Error(`谱面 ${game.poolMap?.code||game.beatmapId}（ID ${game.beatmapId}）资料读取失败：${error.message}`);
      const existing=game.beatmap||{},hasMetadata=Boolean(existing.version||existing.beatmapset?.title);
      game.beatmap=hasMetadata?{...existing,id:game.beatmapId,deleted:false}:{id:game.beatmapId,deleted:true,beatmapset:{}};
      beatmapCache.set(game.beatmapId,game.beatmap);
    }
    if (modeLabel === 'osu!') game.displayBeatmap = await fetchModdedBeatmap(game, token, moddedBeatmapCache);
    onProgress((gameIndex + 1) / games.length, `正在获取谱面及模组资料 ${gameIndex + 1}/${games.length}…`);
  }
}

function validatePool(pool) {
  if (!pool.length) throw new Error('图池 CSV 中没有可用的谱面 ID。请确认包含 id/code 与 map id/beatmap_id 列。');
  const byId = new Map();
  for (const map of pool) {
    const previous = byId.get(map.beatmapId);
    if (previous && previous !== map.code) throw new Error(`图池中的 beatmap ID ${map.beatmapId} 同时对应 ${previous} 与 ${map.code}，无法严格判定。`);
    byId.set(map.beatmapId, map.code);
  }
}

const server = http.createServer(async (req, res) => {
  let requestGenerationId='';
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/generation-progress') {
      const id = url.searchParams.get('id');
      return json(res, 200, generationProgress.get(id) || { percent:0, message:'等待生成任务启动…' });
    }
    if (req.method === 'GET' && url.pathname === '/api/oauth') return json(res,200,oauth.status());
    if (req.method === 'POST' && url.pathname === '/api/shutdown') {
      json(res, 200, { ok: true });
      setTimeout(async () => {
        beatmapCache.clear();
        moddedBeatmapCache.clear();
        // Generated decks are disposable local-service output. Clear them on
        // shutdown while preserving OAuth (.local), installed fonts, and the
        // application/runtime itself.
        await fs.rm(outputs, { recursive: true, force: true }).catch(() => {});
        await fs.mkdir(outputs, { recursive: true }).catch(() => {});
        server.close(() => process.exit(0));
      }, 150);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/oauth') { const x=JSON.parse((await body(req)).toString('utf8'));await oauth.save(x.clientId,x.clientSecret);await oauth.accessToken();return json(res,200,oauth.status()); }
    if (req.method === 'POST' && url.pathname === '/api/import-match') {
      const input = normalizeTournamentInput(JSON.parse((await body(req)).toString('utf8')));
      if (!String(input.poolCsv || '').trim()) throw new Error('请先上传图池 CSV。应用不再内置图池。');
      const pool = normalizePool(input.poolCsv);
      validatePool(pool);
      const data = await officialPoolGames(input.mplink, pool);
      const series = prepareSeries(data.games, input.bestOf);
      return json(res, 200, {
        games: data.games, pool, picks: series.games.map(game => game.poolMap.code),
        scoringType: data.games.find(game => game.scoringType)?.scoringType,
        score: `${series.redWins}-${series.blueWins}`, complete: series.complete,
        match: data.payload.match, audit: data.audit,
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/generate') {
      const rawInput=JSON.parse((await body(req)).toString('utf8'));
      requestGenerationId=String(rawInput.generationId||'');
      const input = normalizeTournamentInput(rawInput);
      const tournament = requireTournamentTemplate(input);
      const generationId = String(input.generationId || '');
      setGenerationProgress(generationId, 1, '正在校验输入和图池…');
      if (![7, 9, 11, 13, 15].includes(Number(input.bestOf))) throw new Error('请选择 BO7、BO9、BO11、BO13 或 BO15。');
      delete input.games;
      delete input.picks;
      const poolText = String(input.poolCsv || '');
      if (!poolText.trim()) throw new Error('请上传图池 CSV。应用不包含内置图池。');
      const pool = normalizePool(poolText);
      validatePool(pool);
      const poolCodes = new Set(pool.map(map => map.code));
      const std = input.modeLabel === 'osu!';
      const twoStdBans = std && owcBanCount(input) === 2;
      const bpFields = std
        ? [['redBan','红队 Ban 1'],['blueBan','蓝队 Ban 1'],...(twoStdBans?[['redBan2','红队 Ban 2'],['blueBan2','蓝队 Ban 2']]:[])]
        : [['redProtect','红队 Protect'],['blueProtect','蓝队 Protect'],['redBan','红队 Ban'],['blueBan','蓝队 Ban']];
      for (const [field, label] of bpFields) {
        if (!poolCodes.has(String(input[field] || ''))) throw new Error(`${label} 必须选择上传图池中的谱面。`);
      }
      if (std && !['red','blue'].includes(input.firstPicker)) throw new Error('OWC 必须选择实际首选方；Roll 胜者可以指定任意一方首选。');
      if (std && !['red','blue'].includes(input.stdFirstBan)) throw new Error('OWC 必须选择实际先 Ban 方；该选择由 Roll 败者决定。');
      const manual = Object.hasOwn(input, 'editedGames');
      setGenerationProgress(generationId, 3, manual ? '正在校验手动编辑的对局…' : '正在从 mplink 读取官方对局…');
      const selected = manual
        ? validateEditedGames(input.editedGames, pool, input)
        : (await officialPoolGames(input.mplink, pool)).games;
      const series = prepareSeries(selected, input.bestOf);
      const games = series.games;
      if (!games.length) throw new Error('mplink 中未找到图池内的已完成对局。请读取比赛后手动添加对局。');
      delete input.editedGames;
      input.seriesComplete = series.complete;
      await hydrateGames(games, input.modeLabel, (fraction, message) => setGenerationProgress(generationId, 8 + fraction * 22, message));
      input.picks = games.map(game => game.poolMap.code);
      const name = `${safeName(input.competitionName)}_${safeName(input.round)}_${Date.now()}.pptx`;
      const outputPath = path.join(outputs, name);
      const templateName = tournament.template;
      setGenerationProgress(generationId,30,'对局与谱面资料已就绪，正在生成 PPT…');
      const result = await runGenerationJob({ templatePath: path.join(assets, templateName), outputPath, input, pool, games },(fraction,message)=>setGenerationProgress(generationId,30+fraction*69,message));
      const warning = series.complete ? null : `比赛尚未决出胜负，目前比分 ${series.redWins}-${series.blueWins}。`;
      const scoreSource = manual ? 'mplink + 手动编辑' : 'mplink';
      const responseData={ ...result, manual, download: `/outputs/${encodeURIComponent(name)}`, warning, dataSources: { match: 'mplink', players: scoreSource, scores: scoreSource, judgements: scoreSource, beatmapIds: scoreSource, beatmapMetadata: 'osu! beatmap API', poolCodes: 'uploaded pool CSV', formFields: 'manual or match-info CSV' } };
      setGenerationProgress(generationId, 100, '生成完成。', 'complete', responseData);
      setTimeout(() => generationProgress.delete(generationId), 5 * 60 * 1000);
      return json(res, 200, responseData);
    }
    const outputRequest = url.pathname.startsWith('/outputs/');
    const rel = url.pathname === '/' ? 'public/index.html' : url.pathname.replace(/^\//, '');
    const base = outputRequest ? dataRoot : root;
    const full = path.resolve(base, rel);
    if (!full.startsWith(base)) { res.writeHead(403); return res.end(); }
    const data = await fs.readFile(full);
    res.writeHead(200, {'Content-Type': types[path.extname(full)] || 'application/octet-stream'}); res.end(data);
  } catch (error) {
    if(requestGenerationId){const previous=generationProgress.get(requestGenerationId);setGenerationProgress(requestGenerationId,previous?.percent||0,error.message,'failed');}
    json(res, 500, { error: error.message });
  }
});
server.listen(4173, '127.0.0.1', () => console.log('osu! 赛后 PPT 生成器：http://127.0.0.1:4173'));
