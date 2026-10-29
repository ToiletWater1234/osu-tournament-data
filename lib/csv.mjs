export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted;
    } else if (ch === ',' && !quoted) { row.push(field); field = ''; }
    else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(v => v.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const headers = rows.shift()?.map(v => v.replace(/^\uFEFF/, '').trim().toLowerCase()) ?? [];
  return rows.map(cols => Object.fromEntries(headers.map((h, i) => [h, (cols[i] ?? '').trim()])));
}

export function normalizePool(text) {
  return parseCsv(text).map(row => ({
    code: String(row.id || row.code || '?').trim(),
    title: row['artist - title [difficulty]'] || row.title || '?',
    beatmapId: Number(String(row['map id'] || row.beatmap_id || '').trim()) || null,
  })).filter(map => map.code !== '?' && map.beatmapId);
}
