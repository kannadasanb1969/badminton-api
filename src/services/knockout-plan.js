export function bracketSizeFor(count) { let size = 1; while (size < count) size *= 2; return size; }
export function createKnockoutPlan(participants) {
  if (participants.length < 2) throw new Error('At least two participants are required');
  const bracketSize = bracketSizeFor(participants.length);
  const firstMatchCount = participants.length - bracketSize / 2;
  const matches = [];
  let cursor = 0;
  for (let i = 0; i < firstMatchCount; i += 1) matches.push({ round: 1, participants: [participants[cursor++], participants[cursor++]], sources: [] });
  const byes = participants.slice(cursor); let slots = [];
  matches.forEach((source, index) => { slots.push({ source }); if (byes[index]) slots.push({ participant: byes[index] }); });
  byes.slice(matches.length).forEach(participant => slots.push({ participant }));
  let round = 2;
  while (slots.length > 1) {
    const next = [];
    for (let i = 0; i < slots.length; i += 2) {
      const a = slots[i], b = slots[i + 1];
      const match = { round, participants: [a.participant ?? null, b.participant ?? null], sources: [a.source ?? null, b.source ?? null], autoAdvanced: !a.source && !b.source && Boolean(a.participant && b.participant) };
      matches.push(match); next.push(match.autoAdvanced ? { participant: a.participant } : { source: match });
    }
    slots = next; round += 1;
  }
  return { participantCount: participants.length, bracketSize, byeCount: bracketSize - participants.length, firstMatchCount, matches };
}
