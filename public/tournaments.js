export const tournaments = Object.freeze([
  {id:'OWC', modeLabel:'osu!', playersPerTeam:4, template:'template-std.pptx', ready:true},
  {id:'CWC', modeLabel:'osu!catch', playersPerTeam:3, template:null, ready:false},
  {id:'TWC', modeLabel:'osu!taiko', playersPerTeam:2, template:null, ready:false},
  {id:'MWC4k', modeLabel:'osu!mania', playersPerTeam:3, template:'template.pptx', ready:true},
  {id:'MWC7k', modeLabel:'osu!mania', playersPerTeam:2, template:null, ready:false},
].map(profile=>Object.freeze(profile)));

export function resolveTournament(value, competitionName = '') {
  const text=String(value||'').trim().toLowerCase();
  const exact=tournaments.find(profile=>profile.id.toLowerCase()===text);
  if(exact)return exact;
  const legacy={'osu!':'OWC','osu!catch':'CWC','osu!taiko':'TWC','osu!mania':/7\s*k|7\s*key/i.test(competitionName)?'MWC7k':'MWC4k'};
  return tournaments.find(profile=>profile.id===legacy[text])||null;
}

export function normalizeTournamentInput(input) {
  const profile=resolveTournament(input.tournamentType||input.modeLabel,input.competitionName);
  if(!profile)throw new Error('请先选择 OWC、CWC、TWC、MWC4k 或 MWC7k。');
  return {...input,tournamentType:profile.id,modeLabel:profile.modeLabel,playersPerTeam:profile.playersPerTeam};
}

export function requireTournamentTemplate(input) {
  const profile=resolveTournament(input.tournamentType||input.modeLabel,input.competitionName);
  if(!profile?.ready)throw new Error(`${profile?.id||'所选比赛'} 的专用赛制模板尚未配置，暂不能生成 PPT。`);
  return profile;
}
