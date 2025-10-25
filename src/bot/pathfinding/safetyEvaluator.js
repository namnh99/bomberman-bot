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

  // Calculate time to reach this tile with accurate speed calculation
  // Formula: timePerGrid = (GRID_SIZE / speed) * STEP_DELAY
  // Each grid cell takes (40px / speed px/tick) * 20ms/tick
  const timePerGridCell = (GRID_SIZE / currentSpeed) * STEP_DELAY

  // Add alignment overhead: each move may need up to half a grid cell alignment
  // Conservative estimate: add 50% overhead for alignment
  const alignmentOverhead = timePerGridCell * 0.5

  // Total time with safety margin for network delays and alignment
  const timeToReach = stepsToReach * timePerGridCell + alignmentOverhead

  // Additional safety buffer based on speed - slower movement needs more buffer
  const speedSafetyFactor = Math.max(1, 2 / currentSpeed) // Slower = higher factor
  const networkBuffer = 300 * speedSafetyFactor // 300-600ms network buffer

  // Debug logging for timing calculations (only log first few checks)
  if (stepsToReach <= 3 && bombs.length > 0) {
    console.log(
      `      🕐 Timing check [${x},${y}]: ${stepsToReach} steps @ speed ${currentSpeed} = ${timeToReach.toFixed(0)}ms (${timePerGridCell.toFixed(0)}ms/grid + ${alignmentOverhead.toFixed(0)}ms align)`,
    )
  }

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

    // CRITICAL: Check if bomb timestamps are server time or client time
    // If createdAt is way in the past/future, we have a time sync issue
    const timeDiff = now - bombCreatedAt
    if (Math.abs(timeDiff) > bombLifeTime * 2) {
      console.warn(
        `⚠️  TIME SYNC ISSUE! Bomb created ${timeDiff}ms ago (expected < ${bombLifeTime * 2}ms)`,
      )
      console.warn(`   This suggests server time ≠ client time!`)
      console.warn(`   Bomb: createdAt=${bombCreatedAt}, now=${now}, diff=${timeDiff}`)
    }

    const timeUntilExplosion = bombLifeTime - (now - bombCreatedAt)

    // DEBUG: Log timing calculations for first few tiles
    if (stepsToReach <= 3 && bombs.length > 0) {
      console.log(
        `         💣 Bomb [${gridBombX},${gridBombY}]: created=${bombCreatedAt}, life=${bombLifeTime}ms, now=${now}`,
      )
      console.log(
        `            Time until explosion: ${bombLifeTime}ms - (${now} - ${bombCreatedAt}) = ${timeUntilExplosion.toFixed(0)}ms`,
      )

      if (timeUntilExplosion < 0) {
        console.log(
          `            ⚠️  BOMB ALREADY EXPLODED! (${timeUntilExplosion.toFixed(0)}ms ago)`,
        )
      } else if (timeUntilExplosion > bombLifeTime) {
        console.log(
          `            ⚠️  TIME CALCULATION ERROR! Explosion time > lifeTime (${timeUntilExplosion.toFixed(0)}ms > ${bombLifeTime}ms)`,
        )
      }
    }

    // Check if tile IS the bomb location
    if (x === gridBombX && y === gridBombY) {
      // Only allow crossing the bomb tile if we can pass BEFORE it explodes
      // Need MUCH larger buffer when crossing bomb tile directly
      const BOMB_TILE_BUFFER = 2000 + networkBuffer // 2.3-2.6s buffer (speed-dependent)
      const canCrossSafely =
        timeUntilExplosion > 0 && timeToReach < timeUntilExplosion - BOMB_TILE_BUFFER

      if (stepsToReach <= 3 && bombs.length > 0) {
        console.log(
          `         💣 Bomb at [${gridBombX},${gridBombY}] explodes in ${timeUntilExplosion.toFixed(0)}ms | Crossing tile needs ${timeToReach.toFixed(0)}ms + ${BOMB_TILE_BUFFER.toFixed(0)}ms buffer → ${canCrossSafely ? "✅ SAFE" : "❌ UNSAFE"}`,
        )
      }

      if (canCrossSafely) {
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
      // Buffer scales with speed - slower movement needs more buffer
      const SAFETY_BUFFER = 1500 + networkBuffer // 1.8-2.1s safety margin (speed-dependent)
      const canPassSafely =
        timeUntilExplosion > 0 && timeToReach < timeUntilExplosion - SAFETY_BUFFER

      if (stepsToReach <= 3 && bombs.length > 0) {
        console.log(
          `         💥 Tile in blast zone of [${gridBombX},${gridBombY}] | Need ${timeToReach.toFixed(0)}ms + ${SAFETY_BUFFER.toFixed(0)}ms buffer vs ${timeUntilExplosion.toFixed(0)}ms available → ${canPassSafely ? "✅ SAFE" : "❌ UNSAFE"}`,
        )
      }

      if (!canPassSafely) {
        return false // Will be caught in explosion
      }
      // Otherwise we can pass through safely
    }
  }

  return true
}
