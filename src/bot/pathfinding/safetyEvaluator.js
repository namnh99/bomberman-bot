import {
  GRID_SIZE,
  DIRS,
  BLOCKABLE_EXPLOSION,
  BOMB_EXPLOSION_TIME,
  STEP_DELAY,
} from "../../utils/constants.js"
import { inBounds, toGridCoords } from "../../utils/gridUtils.js"

/**
 * Check if a tile will be safe by the time we reach it (considering bomb timers)
 * @param {number} x - Grid X coordinate
 * @param {number} y - Grid Y coordinate
 * @param {number} stepsToReach - Number of steps to reach this tile
 * @param {Array} bombs - Array of active bombs
 * @param {Array} allBombers - Array of all bombers
 * @param {Object} map - Game map
 * @param {number} currentSpeed - Current movement speed (pixels per tick)
 * @returns {boolean} - True if tile will be safe when we reach it
 */
export function isTileSafeByTime(x, y, stepsToReach, bombs, allBombers, map, currentSpeed = 1) {
  const now = Date.now()
  // Calculate time to reach this tile (steps * GRID_SIZE / speed * STEP_DELAY)
  const timeToReach = ((stepsToReach * GRID_SIZE) / currentSpeed) * STEP_DELAY

  const h = map.length
  const w = map[0].length

  // Check each bomb to see if it will explode before we reach this tile
  for (const bomb of bombs) {
    if (bomb.isExploded) continue

    const owner = allBombers.find((b) => b.uid === bomb.uid)
    const range = owner ? owner.explosionRange : 2

    const { x: gridBombX, y: gridBombY } = toGridCoords(bomb.x, bomb.y)

    // Calculate when this bomb will explode using server's lifeTime
    const bombCreatedAt = bomb.createdAt || now
    const bombLifeTime = bomb.lifeTime || BOMB_EXPLOSION_TIME
    const timeUntilExplosion = bombLifeTime - (now - bombCreatedAt)

    // Check if tile IS the bomb location
    if (x === gridBombX && y === gridBombY) {
      // Only allow crossing the bomb tile if we can pass BEFORE it explodes
      if (timeUntilExplosion > 0 && timeToReach < timeUntilExplosion) {
        continue
      } else {
        return false
      }
    }

    // Check if tile is in explosion range
    let isInBlastZone = false
    for (const [dx, dy] of DIRS) {
      for (let step = 1; step <= range; step++) {
        const nx = gridBombX + dx * step
        const ny = gridBombY + dy * step

        if (!inBounds(nx, ny, map)) break
        if (BLOCKABLE_EXPLOSION.includes(map[ny][nx])) break

        if (nx === x && ny === y) {
          isInBlastZone = true
          break
        }
      }
      if (isInBlastZone) break
    }

    // If tile is in blast zone, check timing
    if (isInBlastZone) {
      // Can only pass through if we reach BEFORE bomb explodes AND have buffer time
      const SAFETY_BUFFER = 200 // 200ms safety margin
      if (timeUntilExplosion <= 0 || timeToReach >= timeUntilExplosion - SAFETY_BUFFER) {
        return false // Will be caught in explosion
      }
      // Otherwise we can pass through safely
    }
  }

  return true
}
