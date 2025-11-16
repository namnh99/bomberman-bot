/**
 * Calculate remaining bombs that a bomber can place
 * @param {Object} bomber - The bomber object with bombCount (capacity)
 * @param {Array} allBombs - Array of all active bombs
 * @param {string} bomberUid - The bomber's UID
 * @returns {number} - Number of bombs this bomber can still place
 */
export function getRemainingBombs(bomber, allBombs, bomberUid) {
  if (!bomber || !bomber.bombCount) return 0

  // bombCount is the CAPACITY (total bombs can place at once)
  const capacity = bomber.bombCount

  // Count how many bombs this bomber currently has active
  const activeBombsCount = allBombs.filter((bomb) => bomb.uid === bomberUid).length

  // Remaining = capacity - active bombs
  const remaining = capacity - activeBombsCount
  return Math.max(0, remaining)
}

/**
 * Check if a bomber can place a bomb
 * @param {Object} bomber - The bomber object
 * @param {Array} allBombs - Array of all active bombs
 * @param {string} bomberUid - The bomber's UID
 * @returns {boolean} - True if can place bomb
 */
export function canPlaceBomb(bomber, allBombs, bomberUid) {
  return getRemainingBombs(bomber, allBombs, bomberUid) > 0
}
