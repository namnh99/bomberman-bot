import { BOMB_EXPLOSION_TIME, GRID_SIZE } from "./constants.js"
import { toGridCoords } from "./gridUtils.js"

/**
 * Get bomb with grid coordinates
 * @param {Object} bomb - Bomb object
 * @returns {Object} Bomb with gridX, gridY properties
 */
export function getBombWithGrid(bomb) {
  const { x: gridX, y: gridY } = toGridCoords(bomb.x, bomb.y)
  return { ...bomb, gridX, gridY }
}

/**
 * Get bomb explosion range (prioritize bomb.explosionRange over owner)
 * @param {Object} bomb - Bomb object
 * @param {Array} bombers - All bombers
 * @returns {number} Explosion range
 */
export function getBombRange(bomb, bombers) {
  if (bomb.explosionRange) return bomb.explosionRange

  const owner = bombers.find((b) => b.uid === bomb.uid)
  return owner ? owner.explosionRange : 2
}

/**
 * Get bomb time until explosion
 * @param {Object} bomb - Bomb object
 * @returns {number} Time in milliseconds
 */
export function getTimeUntilExplosion(bomb) {
  const now = Date.now()
  const createdAt = bomb.createdAt || now
  const lifeTime = bomb.lifeTime || 5000
  return Math.max(0, lifeTime - (now - createdAt))
}

/**
 * Check if position is in bomb's blast zone
 * @param {number} x - Grid X coordinate
 * @param {number} y - Grid Y coordinate
 * @param {Object} bomb - Bomb object with gridX, gridY
 * @param {number} range - Explosion range
 * @returns {boolean} True if in blast zone
 */
export function isInBlastZone(x, y, bomb, range) {
  const dx = Math.abs(x - bomb.gridX)
  const dy = Math.abs(y - bomb.gridY)
  return (dx === 0 && dy <= range) || (dy === 0 && dx <= range)
}

export function createFutureBomb(x, y, explosionRange, uid) {
  return {
    x: x * GRID_SIZE,
    y: y * GRID_SIZE,
    explosionRange,
    uid,
    createdAt: Date.now(),
    lifeTime: BOMB_EXPLOSION_TIME,
    isFuture: true, // Flag to distinguish from real server bombs
  }
}
