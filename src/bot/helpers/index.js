import { BOMB_EXPLOSION_TIME, GRID_SIZE } from "../../utils/constants.js"

/**
 * Create a future bomb object with proper timing info for escape path calculation
 */
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
