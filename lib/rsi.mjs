// Final user-supplied formula: (player score / losing team's mean score)^1.5.
// Missing participants cannot be counted as zero, or omitted from the divisor.
export function loserTeamAverage(game, playersPerTeam) {
  if(!Number.isInteger(playersPerTeam)||playersPerTeam<1)return null;
  const teamScores=team=>(game?.scores||[]).filter(row=>row.team===team);
  const red=teamScores('red'),blue=teamScores('blue');
  const valid=rows=>rows.length===playersPerTeam&&rows.every(row=>row.score!==null&&row.score!==undefined&&row.score!==''&&Number.isFinite(Number(row.score))&&Number(row.score)>=0);
  if(!valid(red)||!valid(blue))return null;
  const sum=rows=>rows.reduce((total,row)=>total+Number(row.score),0);
  const redTotal=sum(red),blueTotal=sum(blue);
  if(redTotal===blueTotal)return null;
  const average=Math.min(redTotal,blueTotal)/playersPerTeam;
  return average>0?average:null;
}

export function relativeScoreIndex(score, loserAverage) {
  if(score===null||score===undefined||score===''||!Number.isFinite(Number(score))||Number(score)<0||!(loserAverage>0))return null;
  const value=(Number(score)/loserAverage)**1.5;
  return Number.isFinite(value)?value:null;
}
