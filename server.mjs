import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns';
import { normalizePool } from './lib/csv.mjs';
import { fetchMatch, fetchMatchApi, fetchBeatmap, fetchModdedBeatmap, extractGames, selectPoolGames } from './lib/osu.mjs';
import { runGenerationJob } from './lib/generation-job.mjs';
import { OAuthStore } from './lib/oauth.mjs';
import { normalizeTournamentInput, requireTournamentTemplate } from './public/tournaments.js';

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
async function officialPoolGames(mplink, pool, onProgress = null, modeLabel = null) {
  onProgress?.(0, '正在从 mplink 读取官方对局…');
  const payload = await loadMatch(mplink);
  onProgress?.(0.12, '已读取对局，正在严格比对图池 ID…');
  const allGames = extractGames(payload);
  const selected = selectPoolGames(allGames, pool);
  if (!selected.length) throw new Error('mplink 中没有找到属于所上传图池的已完成对局。非图池谱面已自动跳过。');
  const token = await oauth.accessToken();
  for (let gameIndex = 0; gameIndex < selected.length; gameIndex++) {
    const game = selected[gameIndex];
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
    onProgress?.(0.12 + 0.88 * (gameIndex + 1) / Math.max(1, selected.length), `正在获取谱面及模组资料 ${gameIndex + 1}/${selected.length}…`);
  }
  const poolIds = new Set(pool.map(map => Number(map.beatmapId)));
  const ignoredBeatmapIds = [...new Set(allGames.filter(game => game.beatmapId && game.scores?.length && !poolIds.has(Number(game.beatmapId))).map(game => Number(game.beatmapId)))];
  const scoredRoomGames = allGames.filter(game => Array.isArray(game.scores) && game.scores.length > 0).length;
  const emptyGameEvents = allGames.length - scoredRoomGames;
  return { payload, games: selected, picks: selected.map(game => game.poolMap.code), audit: { roomGames: scoredRoomGames, emptyGameEvents, matchedGames: selected.length, ignoredBeatmapIds } };
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

function prepareSeries(games, bestOf) {
  const needed = (Number(bestOf) + 1) / 2;
  if (!Number.isInteger(needed) || needed < 1) return { games, redWins: 0, blueWins: 0, complete: false };
  let redWins = 0, blueWins = 0;
  const official = [];
  for (const game of games) {
    if (redWins >= needed || blueWins >= needed) continue;
    const red = (game.scores || []).filter(score => score.team === 'red').reduce((n, score) => n + (Number(score.score) || 0), 0);
    const blue = (game.scores || []).filter(score => score.team === 'blue').reduce((n, score) => n + (Number(score.score) || 0), 0);
    let winner = null;
    if (red && blue) { if (red > blue) { redWins++; winner = 'red'; } else if (blue > red) { blueWins++; winner = 'blue'; } }
    official.push({ ...game, redTotal: red, blueTotal: blue, winner, difference: red && blue ? Math.abs(red - blue) : null, redWinsAfter: redWins, blueWinsAfter: blueWins });
  }
  return { games: official, redWins, blueWins, complete: redWins >= needed || blueWins >= needed };
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
      const data = await officialPoolGames(input.mplink, pool, null, input.modeLabel);
      const series = prepareSeries(data.games, input.bestOf);
      return json(res, 200, { games: series.games, picks: series.games.map(game => game.poolMap.code), score: `${series.redWins}-${series.blueWins}`, complete: series.complete, match: data.payload.match, audit: data.audit });
    }
    if (req.method === 'POST' && url.pathname === '/api/generate') {
      const rawInput=JSON.parse((await body(req)).toString('utf8'));
      requestGenerationId=String(rawInput.generationId||'');
      const input = normalizeTournamentInput(rawInput);
      const tournament = requireTournamentTemplate(input);
      const generationId = String(input.generationId || '');
      setGenerationProgress(generationId, 1, '正在校验输入和图池…');
      // Client-side cached games/picks are never authoritative. Every PPT build
      // reloads the official match and beatmap records from the supplied mplink.
      delete input.games;
      delete input.picks;
      const poolText = String(input.poolCsv || '');
      if (!poolText.trim()) throw new Error('请上传图池 CSV。应用不包含内置图池。');
      const pool = normalizePool(poolText);
      validatePool(pool);
      const poolCodes = new Set(pool.map(map => map.code));
      const std = input.modeLabel === 'osu!';
      const twoStdBans = std && /(quarter|semi|final|grand|bracket reset)/i.test(String(input.round || ''));
      const bpFields = std
        ? [['redBan','红队 Ban 1'],['blueBan','蓝队 Ban 1'],...(twoStdBans?[['redBan2','红队 Ban 2'],['blueBan2','蓝队 Ban 2']]:[])]
        : [['redProtect','红队 Protect'],['blueProtect','蓝队 Protect'],['redBan','红队 Ban'],['blueBan','蓝队 Ban']];
      for (const [field, label] of bpFields) {
        if (!poolCodes.has(String(input[field] || ''))) throw new Error(`${label} 必须选择上传图池中的谱面。`);
      }
      if (std && !['red','blue'].includes(input.firstPicker)) throw new Error('OWC 必须选择实际首选方；Roll 胜者可以指定任意一方首选。');
      if (std && !['red','blue'].includes(input.stdFirstBan)) throw new Error('OWC 必须选择实际先 Ban 方；该选择由 Roll 败者决定。');
      const imported = await officialPoolGames(input.mplink, pool, (fraction, message) => setGenerationProgress(generationId, 3 + fraction * 27, message), input.modeLabel);
      const series = prepareSeries(imported.games, input.bestOf);
      const games = series.games;
      input.picks = games.map(game => game.poolMap.code);
      const name = `${safeName(input.competitionName)}_${safeName(input.round)}_${Date.now()}.pptx`;
      const outputPath = path.join(outputs, name);
      const templateName = tournament.template;
      setGenerationProgress(generationId,30,'官方数据已读取，正在启动 PPT 页面生成…');
      const result = await runGenerationJob({ templatePath: path.join(assets, templateName), outputPath, input, pool, games },(fraction,message)=>setGenerationProgress(generationId,30+fraction*69,message));
      const warning = !games.length ? 'mplink 数据未读取到，缺失比分已填 ?' : (!series.complete ? `比赛数据未形成完整胜负，目前累计 ${series.redWins}-${series.blueWins}。请核对 mplink、图池 ID 和缺失分数。` : null);
      const responseData={ ...result, download: `/outputs/${encodeURIComponent(name)}`, warning, dataSources: { match: 'mplink', players: 'mplink', scores: 'mplink', judgements: 'mplink', beatmapIds: 'mplink', beatmapMetadata: 'osu! beatmap API', poolCodes: 'uploaded pool CSV', formFields: 'manual or match-info CSV' } };
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
