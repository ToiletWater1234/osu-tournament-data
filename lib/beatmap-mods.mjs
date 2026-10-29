// Shared map information uses the pool's required mods and room-wide mods.
// FreeMod players' optional mods must not be combined into one fictitious map.
export function normalizeMods(mods = []) {
  return [...new Set(mods.map(mod => String(typeof mod === 'string' ? mod : mod?.acronym || '').toUpperCase()).filter(Boolean))].sort();
}

export function mapDisplayMods(game) {
  const code = String(game.poolMap?.code || '').toUpperCase();
  const prefix = code.replace(/\d+$/, '');
  const poolMods = /^(?:(?:HD|HR|DT|NC|HT|EZ))+$/.test(prefix) ? prefix.match(/HD|HR|DT|NC|HT|EZ/g) : [];
  return normalizeMods([...(poolMods || []), ...(game.mods || [])]).filter(mod => ['HD','HR','DT','NC','HT','EZ','FL'].includes(mod));
}

export function applyStdModAttributes(beatmap, mods, attributes) {
  const set = new Set(normalizeMods(mods));
  const rate = set.has('DT') || set.has('NC') ? 1.5 : set.has('HT') ? 0.75 : 1;
  const modify = (value, hrMultiplier) => {
    if (value == null) return null;
    let result = Number(value);
    if (set.has('EZ')) result *= 0.5;
    if (set.has('HR')) result = Math.min(10, result * hrMultiplier);
    return result;
  };
  const ar = modify(beatmap.ar, 1.4);
  const od = modify(beatmap.accuracy, 1.4);
  const preempt = ar == null ? null : ar < 5 ? 1800 - 120 * ar : 1950 - 150 * ar;
  const effectivePreempt = preempt == null ? null : preempt / rate;
  return {
    ...beatmap,
    difficulty_rating: attributes.star_rating,
    max_combo: attributes.max_combo > 0 ? attributes.max_combo : beatmap.max_combo > 0 ? beatmap.max_combo : null,
    total_length: beatmap.total_length == null ? null : Math.floor(beatmap.total_length / rate),
    hit_length: beatmap.hit_length == null ? null : Math.floor(beatmap.hit_length / rate),
    bpm: beatmap.bpm == null ? null : Number(beatmap.bpm) * rate,
    cs: modify(beatmap.cs, 1.3),
    drain: modify(beatmap.drain, 1.4),
    ar: effectivePreempt == null ? null : rate === 1 ? ar : effectivePreempt > 1200 ? (1800 - effectivePreempt) / 120 : (1950 - effectivePreempt) / 150,
    accuracy: od == null ? null : rate === 1 ? od : (80 - (80 - 6 * od) / rate) / 6,
    appliedMods: normalizeMods(mods),
    clockRate: rate,
  };
}
