export function normalizeRoll(value) {
  const text=String(value??'').trim();
  const keyword=text.toLowerCase();
  if(keyword==='win'||keyword==='lose')return keyword;
  return /^\d+$/.test(text)?String(Number(text)):text;
}

export function rollRank(value) {
  const roll=normalizeRoll(value);
  if(roll==='win')return Number.POSITIVE_INFINITY;
  if(roll==='lose')return Number.NEGATIVE_INFINITY;
  const number=Number(roll);
  return Number.isFinite(number)?number:Number.NEGATIVE_INFINITY;
}

export function firstPickerFromRolls(redRoll,blueRoll) {
  return rollRank(redRoll)>=rollRank(blueRoll)?'red':'blue';
}
