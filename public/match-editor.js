import { calculateAccuracy, formatAccuracy, gameResult, judgementFields, parseCount, statValue } from './match-data.js';

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text, action, disabled = false) {
  const node = element('button', text, 'editor-button');
  node.type = 'button';
  node.disabled = disabled;
  node.addEventListener('click', action);
  return node;
}

function input(label, value, update, numeric = false) {
  const field = element('input');
  field.setAttribute('aria-label', label);
  field.value = value ?? '';
  if (numeric) field.inputMode = numeric === 'decimal' ? 'decimal' : 'numeric';
  field.addEventListener('input', () => update(field.value));
  return field;
}

export function createMatchEditor(section, onChange) {
  const toolbar = section.querySelector('.editor-toolbar');
  const content = section.querySelector('.editor-content');
  let games = [], pool = [], profile, scoringType, selected = 0, changed = false;

  function markChanged() {
    changed = true;
    onChange(games);
  }

  function update(action) {
    action();
    markChanged();
    render();
  }

  function renderTeam(game, team, title) {
    const teamRows = game.scores.filter(row => row.team === team);
    const judgements = judgementFields(profile.modeLabel);
    const wrapper = element('div', null, 'editor-team');
    const heading = element('div', null, 'editor-actions');
    const total = element('h3');
    function updateTotal() {
      const result = gameResult(game.scores);
      const score = team === 'red' ? result.redTotal : result.blueTotal;
      total.textContent = `${title} · ${teamRows.length}/${profile.playersPerTeam} 人 · ${score.toLocaleString('zh-CN')} 分`;
    }
    updateTotal();
    heading.append(total, button('加人', () => update(() => game.scores.push({
      team, name: '', score: '', statistics: {}, recalculateAccuracy: true,
    })), teamRows.length >= profile.playersPerTeam));
    wrapper.append(heading);
    if (!teamRows.length) return wrapper;

    const scroll = element('div', null, 'editor-table-scroll');
    const table = element('table');
    const headers = element('tr');
    for (const text of ['昵称', '分数', ...judgements.map(([, label]) => label), 'ACC', '操作']) {
      const header = element('th', text);
      header.scope = 'col';
      headers.append(header);
    }
    table.createTHead().append(headers);
    const body = table.createTBody();
    for (const [index, row] of teamRows.entries()) {
      const tr = body.insertRow();
      const label = `${title}第 ${index + 1} 位玩家`;
      const direct = row.accuracyMode === 'direct';
      const accValue = element('output');
      const refreshAccuracy = () => {
        const accuracy = row.recalculateAccuracy
          ? calculateAccuracy(row, profile.modeLabel, game.scoringType)
          : row.accuracy;
        accValue.textContent = formatAccuracy(accuracy);
      };
      tr.insertCell().append(input(`${label}昵称`, row.name, value => { row.name = value; markChanged(); }));
      tr.insertCell().append(input(`${label}分数`, row.score, value => {
        row.score = value;
        markChanged();
        updateTotal();
      }, true));
      for (const [key, title] of judgements) {
        const cell = tr.insertCell();
        if (direct) { cell.textContent = '?'; continue; }
        cell.append(input(`${label} ${title} 判定`, statValue(row, key), value => {
          row.statistics[key] = value;
          row.recalculateAccuracy = true;
          markChanged();
          refreshAccuracy();
        }, true));
      }
      const accuracyCell = tr.insertCell();
      const mode = element('select');
      mode.setAttribute('aria-label', `${label} ACC 录入方式`);
      mode.append(new Option('按判定', 'judgements'), new Option('直接填写', 'direct'));
      mode.value = direct ? 'direct' : 'judgements';
      mode.addEventListener('change', () => update(() => {
        row.accuracyMode = mode.value;
        if (mode.value === 'direct' && row.manualAccuracy == null) {
          refreshAccuracy();
          row.manualAccuracy = accValue.textContent.replace('%', '').replace('?', '');
        }
      }));
      accuracyCell.append(mode);
      if (direct) {
        const field = input(`${label} ACC（百分比）`, row.manualAccuracy, value => { row.manualAccuracy = value; markChanged(); }, 'decimal');
        field.placeholder = '例如 98.75';
        accuracyCell.append(field);
      } else {
        refreshAccuracy();
        accuracyCell.append(accValue);
      }
      tr.insertCell().append(button('删人', () => update(() => game.scores.splice(game.scores.indexOf(row), 1))));
    }
    scroll.append(table);
    wrapper.append(scroll);
    return wrapper;
  }

  function render() {
    toolbar.replaceChildren();
    content.replaceChildren();
    if (games.length) {
      const rounds = element('select');
      rounds.setAttribute('aria-label', '选择对局');
      games.forEach((game, index) => rounds.add(new Option(`第 ${index + 1} 局 · ${game.poolMap?.code || '待选谱面'}`, index)));
      rounds.value = selected;
      rounds.addEventListener('change', () => { selected = Number(rounds.value); render(); });
      toolbar.append(rounds);
    }
    toolbar.append(button('新增对局', () => update(() => {
      games.push({ beatmapId: '', scores: [], mods: [], scoringType, added: true });
      selected = games.length - 1;
    })));
    if (!games.length) {
      content.append(element('p', '当前没有对局。点击“新增对局”并选择谱面。'));
      return;
    }

    const game = games[selected];
    const move = offset => update(() => {
      const destination = selected + offset;
      [games[selected], games[destination]] = [games[destination], games[selected]];
      selected = destination;
    });
    toolbar.append(button('上移', () => move(-1), selected === 0), button('下移', () => move(1), selected === games.length - 1), button('删除本局', () => update(() => {
      games.splice(selected, 1);
      selected = Math.max(0, Math.min(selected, games.length - 1));
    })));
    if (game.added) {
      const mapSelect = element('select');
      mapSelect.setAttribute('aria-label', '选择谱面');
      mapSelect.append(new Option('选择图池谱面', ''));
      pool.forEach(map => mapSelect.add(new Option(`${map.code} · ${map.title} (${map.beatmapId})`, map.beatmapId)));
      mapSelect.value = game.beatmapId;
      mapSelect.addEventListener('change', () => update(() => {
        game.beatmapId = parseCount(mapSelect.value) ?? '';
        game.poolMap = pool.find(map => map.beatmapId === game.beatmapId);
      }));
      content.append(mapSelect);
      if (profile.modeLabel === 'osu!mania') {
        const scoring = element('select');
        scoring.setAttribute('aria-label', '判定计算规则');
        scoring.append(new Option('ScoreV1', 'score'), new Option('ScoreV2', 'scorev2'));
        scoring.value = game.scoringType;
        scoring.addEventListener('change', () => update(() => { game.scoringType = scoring.value; }));
        content.append(scoring);
      }
    }
    content.append(renderTeam(game, 'red', '红队'), renderTeam(game, 'blue', '蓝队'));
  }

  return {
    get changed() { return changed; },
    load(data, tournament) {
      profile = tournament;
      pool = data.pool;
      scoringType = data.scoringType ? (data.scoringType === 'scorev2' ? 'scorev2' : 'score') : 'scorev2';
      games = data.games.map(game => ({ ...game, scores: game.scores.map(row => ({ ...row, statistics: { ...row.statistics } })) }));
      selected = 0;
      changed = false;
      section.hidden = !profile.ready;
      render();
    },
    hide() { section.hidden = true; },
    show() { section.hidden = !profile?.ready; },
    snapshot() {
      return games.map(({ beatmapId, poolMap, mods, scoringType, scores }) => ({
        beatmapId, poolMap, mods, scoringType, scores,
      }));
    },
  };
}
