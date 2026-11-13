const judgementAliases = {
  perfect: ['perfect', 'count_perfect', 'count_geki', 'count_300g'],
  great: ['great', 'count_great', 'count_300'],
  good: ['good', 'count_good', 'count_katu', 'count_200'],
  ok: ['ok', 'count_ok', 'count_100'],
  meh: ['meh', 'count_meh', 'count_50'],
  miss: ['miss', 'count_miss'],
};

export function judgementFields(modeLabel) {
  return modeLabel === 'osu!mania'
    ? [['perfect', '300G'], ['great', '300'], ['good', '200'], ['ok', '100'], ['meh', '50'], ['miss', 'MISS']]
    : [['great', '300'], ['ok', '100'], ['meh', '50'], ['miss', 'MISS']];
}

export function statValue(row, key) {
  for (const alias of judgementAliases[key] ?? [key]) {
    if (row?.statistics?.[alias] != null) return row.statistics[alias];
  }
  return null;
}

export function calculateAccuracy(row, modeLabel, scoringType) {
  const max = modeLabel === 'osu!mania' && scoringType === 'scorev2' ? 305 : 300;
  const weights = { perfect: max, great: 300, good: 200, ok: 100, meh: 50, miss: 0 };
  let hits = 0;
  let weighted = 0;
  for (const [key] of judgementFields(modeLabel)) {
    const count = parseCount(statValue(row, key));
    if (count === null) return null;
    hits += count;
    weighted += count * weights[key];
  }
  // Legacy mplink scores with zero judgments report 100%.
  return hits === 0 ? 1 : weighted / (max * hits);
}

const percentage = new Intl.NumberFormat('en-US', {
  style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2,
});

export function formatAccuracy(value) {
  return Number.isFinite(value) ? percentage.format(value) : '?';
}

export function parseCount(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value.trim()))) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

export const byDescendingScore = (a, b) => (parseCount(b.score) ?? 0) - (parseCount(a.score) ?? 0);

export function gameResult(scores) {
  let redTotal = 0, blueTotal = 0, redPlayers = 0, bluePlayers = 0;
  for (const row of scores ?? []) {
    const score = parseCount(row.score);
    if (score === null) continue;
    if (row.team === 'red') { redTotal += score; redPlayers++; }
    if (row.team === 'blue') { blueTotal += score; bluePlayers++; }
  }
  const difference = redPlayers && bluePlayers ? Math.abs(redTotal - blueTotal) : null;
  const winner = difference ? (redTotal > blueTotal ? 'red' : 'blue') : null;
  return { redTotal, blueTotal, winner, difference };
}

export function prepareSeries(games, bestOf, { manual = false } = {}) {
  const needed = (Number(bestOf) + 1) / 2;
  const hasTarget = Number.isInteger(needed) && needed > 0;
  let redWins = 0, blueWins = 0;
  const selected = [];
  for (const game of games) {
    if (!manual && hasTarget && (redWins >= needed || blueWins >= needed || selected.length >= Number(bestOf))) break;
    const result = gameResult(game.scores);
    if (result.winner === 'red') redWins++;
    if (result.winner === 'blue') blueWins++;
    selected.push({ ...game, ...result, redWinsAfter: redWins, blueWinsAfter: blueWins });
  }
  const complete = hasTarget && redWins !== blueWins && Math.max(redWins, blueWins) >= needed;
  return { games: selected, redWins, blueWins, complete };
}
