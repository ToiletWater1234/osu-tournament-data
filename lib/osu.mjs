import { fetchWithRetry } from './network.mjs';
import { normalizeMods, mapDisplayMods, applyStdModAttributes } from './beatmap-mods.mjs';
const unescapeHtml = s => s.replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&#039;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>');

function scriptJson(html, id) {
  const re = new RegExp(`<script[^>]+id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/script>`, 'i');
  const hit = html.match(re);
  if (!hit) return null;
  try { return JSON.parse(unescapeHtml(hit[1].trim())); } catch { return null; }
}

export async function fetchMatch(matchLink) {
  const id = String(matchLink).match(/matches\/(\d+)/)?.[1] || String(matchLink).match(/^\d+$/)?.[0];
  if (!id) throw new Error('mplink 格式无效');
  const response = await fetchWithRetry(`https://osu.ppy.sh/community/matches/${id}`, {
    headers: { 'User-Agent': 'osu-match-ppt-generator/1.0', Accept: 'text/html,application/xhtml+xml' },
  }, 'osu! 比赛页面');
  if (!response.ok) throw new Error(`osu! 返回 HTTP ${response.status}`);
  const html = await response.text();
  const events = scriptJson(html, 'json-events') || scriptJson(html, 'json-match-events');
  const users = scriptJson(html, 'json-users') || [];
  const match = scriptJson(html, 'json-match') || {};
  if (!Array.isArray(events)) throw new Error('比赛页未提供可解析的对局数据');
  return { id: Number(id), events, users, match };
}

export async function fetchMatchApi(matchLink, accessToken) {
  const id = String(matchLink).match(/matches\/(\d+)/)?.[1] || String(matchLink).match(/^\d+$/)?.[0];
  if (!id) throw new Error('mplink 格式无效');
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' };
  const readPage = async before => {
    const suffix = before == null ? '' : `?before=${before}&limit=100`;
    const response = await fetchWithRetry(`https://osu.ppy.sh/api/v2/matches/${id}${suffix}`, { headers }, 'osu! 比赛 API');
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || `osu! API HTTP ${response.status}`);
    return data;
  };
  const first = await readPage(null);
  const events = [...(first.events || [])];
  const users = new Map((first.users || []).map(user => [user.id, user]));
  const seen = new Set(events.map(event => event.id));
  let oldest = events.reduce((n, event) => Math.min(n, Number(event.id)), Infinity);
  while (Number.isFinite(oldest)) {
    const page = await readPage(oldest);
    let added = 0;
    for (const user of page.users || []) users.set(user.id, user);
    for (const event of page.events || []) if (!seen.has(event.id)) { seen.add(event.id); events.push(event); added++; }
    const nextOldest = (page.events || []).reduce((n, event) => Math.min(n, Number(event.id)), Infinity);
    if (!added || !Number.isFinite(nextOldest) || nextOldest >= oldest || (page.events || []).length < 100) break;
    oldest = nextOldest;
  }
  events.sort((a, b) => Number(a.id) - Number(b.id));
  return { ...first, events, users: [...users.values()] };
}

export async function fetchBeatmap(beatmapId, accessToken) {
  let lastError;
  for(let attempt=1;attempt<=5;attempt++){
    const response = await fetchWithRetry(`https://osu.ppy.sh/api/v2/beatmaps/${Number(beatmapId)}`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } }, `osu! 谱面 ${beatmapId}`);
    const data = await response.json().catch(()=>({}));
    if(response.ok)return data;
    const error=new Error(data.message||`osu! 谱面 API HTTP ${response.status}`);error.status=response.status;lastError=error;
    if(response.status===404)throw error;
    if(response.status!==429&&response.status<500)throw error;
    if(attempt<5){const retryAfter=Number(response.headers.get('retry-after'));await new Promise(resolve=>setTimeout(resolve,Number.isFinite(retryAfter)&&retryAfter>0?retryAfter*1000:attempt*750));}
  }
  throw lastError;
}

export async function fetchModdedBeatmap(game, accessToken, cache = new Map()) {
  const beatmap = game.beatmap;
  if (!beatmap || beatmap.deleted || !beatmap.id) return beatmap;
  const mods = mapDisplayMods(game);
  if (!mods.length) return beatmap;
  const key = `${beatmap.id}:osu:${mods.join(',')}`;
  if (cache.has(key)) return cache.get(key);
  const response = await fetchWithRetry(`https://osu.ppy.sh/api/v2/beatmaps/${Number(beatmap.id)}/attributes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ mods, ruleset: 'osu' }),
  }, `osu! 谱面 ${beatmap.id} +${mods.join('')} 属性`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !Number.isFinite(data.attributes?.star_rating)) throw new Error(`谱面 ${beatmap.id} +${mods.join('')} 属性读取失败：${data.message || `HTTP ${response.status}`}。未使用无模组数据代替。`);
  const result = applyStdModAttributes(beatmap, mods, data.attributes);
  cache.set(key, result);
  return result;
}

export function selectPoolGames(games, pool) {
  const poolById = new Map(pool.filter(x => x.beatmapId).map(x => [Number(x.beatmapId), x]));
  const selected = [];
  const played = games.filter(game => Array.isArray(game.scores) && game.scores.length > 0);
  for (let playedIndex = 0; playedIndex < played.length; playedIndex++) {
    const game = played[playedIndex];
    const map = poolById.get(Number(game.beatmapId));
    const deletedMiddleGame = !game.beatmapId && playedIndex > 0 && playedIndex < played.length - 1;
    if (!map && !deletedMiddleGame) continue;
    const item = { ...game, poolMap: map || { code: '?', title: '?', beatmapId: null, deleted: true } };
    const previous = selected.at(-1);
    if (previous && previous.beatmapId && game.beatmapId && Number(previous.beatmapId) === Number(game.beatmapId)) {
      const previousCount = previous.scores?.length || 0, currentCount = game.scores.length;
      const previousTotal = previous.scores.reduce((n, score) => n + (Number(score.score) || 0), 0);
      const currentTotal = game.scores.reduce((n, score) => n + (Number(score.score) || 0), 0);
      if (currentCount > previousCount || (currentCount === previousCount && currentTotal >= previousTotal)) selected[selected.length - 1] = item;
    } else selected.push(item);
  }
  return selected;
}

export function extractGames(payload) {
  const users = new Map((payload?.users || []).map(u => [u.id, u]));
  const rawGames = (payload?.events || []).map(e => e.game).filter(Boolean);
  return rawGames.map(game => {
    const beatmap = game.beatmap || {};
    const scores = (game.scores || []).map(s => ({
      userId: s.user_id,
      name: users.get(s.user_id)?.username || s.user?.username || '?',
      team: String(s.match?.team || s.team || 'none').toLowerCase(),
      slot: Number(s.match?.slot ?? s.slot ?? 999),
      score: Number(s.score || 0),
      accuracy: s.accuracy == null ? null : Number(s.accuracy),
      maxCombo: s.max_combo ?? null,
      statistics: s.statistics || {},
      mods: (s.mods || []).map(mod => typeof mod === 'string' ? mod : (mod?.acronym || mod?.name || '')).filter(Boolean),
    }));
    return { id: game.id, beatmapId: Number(beatmap.id ?? game.beatmap_id) || null, beatmap, scores, mods: normalizeMods(game.mods || []) };
  });
}
