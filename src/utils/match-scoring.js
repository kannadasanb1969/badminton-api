export function isValidWinningPoints(value) {
  return [15, 21, 30].includes(value);
}

export function isMatchCompletionEligible(scoreA, scoreB, winningPoints) {
  return isValidWinningPoints(winningPoints)
    && Number.isInteger(scoreA) && Number.isInteger(scoreB)
    && scoreA >= 0 && scoreB >= 0
    && Math.max(scoreA, scoreB) >= winningPoints
    && Math.abs(scoreA - scoreB) >= 2;
}
