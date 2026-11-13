import { calculateAccuracy, judgementFields, statValue, parseCount, byDescendingScore } from '../public/match-data.js';
import { normalizeMods } from './beatmap-mods.mjs';

export function validateEditedGames(games, pool, { modeLabel, playersPerTeam }) {
  if (!Array.isArray(games) || games.length < 1 || games.length > 15) {
    throw new Error('请保留 1–15 局可生成的对局。');
  }
  const maps = new Map(pool.map(map => [map.beatmapId, map]));
  return games.map((game, index) => {
    const label = `第 ${index + 1} 局`;
    const beatmapId = parseCount(game?.beatmapId);
    const missingMap = game?.beatmapId === null && game?.poolMap?.deleted === true;
    const poolMap = maps.get(beatmapId) ?? (missingMap ? { code: '?', beatmapId: null, deleted: true } : null);
    if (!poolMap) throw new Error(`${label}请选择上传图池中的谱面。`);
    if (!Array.isArray(game.scores) || !game.scores.length) throw new Error(`${label}请至少填写一位玩家，或删除本局。`);
    const scoringType = game.scoringType === 'scorev2' ? 'scorev2' : 'score';
    const teamSize = { red: 0, blue: 0 };
    const scores = game.scores.map((row, playerIndex) => {
      const team = row?.team;
      const player = `${label}第 ${playerIndex + 1} 位玩家`;
      if (team !== 'red' && team !== 'blue') throw new Error(`${player}缺少有效队伍。`);
      if (++teamSize[team] > playersPerTeam) throw new Error(`${label}${team === 'red' ? '红队' : '蓝队'}最多 ${playersPerTeam} 人。`);
      const name = typeof row.name === 'string' ? row.name.trim() : '';
      const score = parseCount(row.score);
      if (!name || /[\x00-\x1f]/.test(name)) throw new Error(`${player}请填写有效昵称。`);
      if (score === null || score > Math.floor(Number.MAX_SAFE_INTEGER / playersPerTeam)) throw new Error(`${player}的分数须为有效非负整数。`);
      const statistics = {};
      const direct = row.accuracyMode === 'direct';
      for (const [key, title] of direct ? [] : judgementFields(modeLabel)) {
        const raw = statValue(row, key);
        const value = parseCount(raw);
        if (value === null && (raw !== null || row.recalculateAccuracy)) throw new Error(`${player}的 ${title} 判定须为非负整数。`);
        if (value !== null) statistics[key] = value;
      }
      let accuracy = row.recalculateAccuracy
        ? calculateAccuracy({ statistics }, modeLabel, scoringType)
        : row.accuracy;
      if (direct) {
        const percent = String(row.manualAccuracy ?? '').trim().replace(/%$/, '').trim();
        if (!/^\d+(?:\.\d+)?$/.test(percent) || Number(percent) > 100) throw new Error(`${player}的 ACC 须为 0–100 的百分比，例如 98.75。`);
        accuracy = Number(`${percent}e-2`);
      }
      return {
        team, name, score, statistics,
        accuracy: Number.isFinite(accuracy) && accuracy >= 0 && accuracy <= 1 ? accuracy : null,
        maxCombo: parseCount(row.maxCombo),
        mods: Array.isArray(row.mods) ? normalizeMods(row.mods) : [],
      };
    });
    return {
      id: index + 1, beatmapId: poolMap.beatmapId, poolMap, scoringType,
      scores: scores.sort(byDescendingScore),
      mods: Array.isArray(game.mods) ? normalizeMods(game.mods) : [],
    };
  });
}
