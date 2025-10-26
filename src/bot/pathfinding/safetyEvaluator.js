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
 * @param {boolean} emergencyMode - If true, use minimal buffers for desperate escapes
 * @returns {boolean} - True if tile will be safe when we reach it
 */
export function isTileSafeByTime(
  x,
  y,
  stepsToReach,
  bombs,
  allBombers,
  map,
  currentSpeed = 1,
  emergencyMode = false,
) {
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

  // EMERGENCY MODE: Use minimal buffers for desperate situations
  // NORMAL MODE: Balanced buffers for safety
  const speedSafetyFactor = Math.max(1, 2 / currentSpeed) // Slower = higher factor
  const networkBuffer = emergencyMode
    ? 200 * speedSafetyFactor // EMERGENCY: 200-400ms (minimal!)
    : 300 * speedSafetyFactor // NORMAL: 300-600ms (reduced from 400ms)

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

    // CRITICAL FIX: Handle server/client time difference
    // If createdAt is in the future (server ahead), clamp elapsed time to 0
    const elapsedTime = Math.max(0, now - bombCreatedAt)

    // If elapsed time > lifeTime, bomb should have exploded (skip it)
    if (elapsedTime >= bombLifeTime) {
      if (stepsToReach <= 3) {
        console.log(
          `         💣 Bomb [${gridBombX},${gridBombY}]: SKIPPED (already exploded: elapsed ${elapsedTime}ms >= life ${bombLifeTime}ms)`,
        )
      }
      continue // Skip this bomb - it should be gone
    }

    const timeUntilExplosion = bombLifeTime - elapsedTime

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
      // EMERGENCY: Minimal buffer (800ms) - desperate situations
      // NORMAL: Reduced buffer (1500ms) - allows crossing with reasonable safety
      const BOMB_TILE_BUFFER = emergencyMode
        ? 800 + networkBuffer // EMERGENCY: 1.0-1.2s (risky but may save life!)
        : 1500 + networkBuffer // NORMAL: 1.8-2.1s (reduced from 2000ms)
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
      // CRITICAL: When crossing blast zones, we need EXTRA time!
      // Bot needs time to FULLY CROSS the tile, not just reach it!
      // Add timePerGridCell as crossing buffer (bot is vulnerable while crossing)
      const crossingTime = timePerGridCell // Time to fully cross this dangerous tile

      // Can only pass through if we reach BEFORE bomb explodes AND have buffer time
      // EMERGENCY: Minimal buffer (500ms) + crossing time - desperate escape
      // NORMAL: Safe buffer (800ms) + crossing time - ensures bot exits blast zone before explosion
      const SAFETY_BUFFER = emergencyMode
        ? 500 + networkBuffer + crossingTime // EMERGENCY: ~1.4-1.6s (minimal but accounts for crossing!)
        : 800 + networkBuffer + crossingTime // NORMAL: ~1.8-2.0s (safe crossing time)
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

/**
 * Calculate the minimum safe time margin for a tile
 * (how much extra time we have before nearest bomb explodes)
 * Higher value = safer tile, prioritize this direction
 *
 * @param {number} x - Grid X coordinate
 * @param {number} y - Grid Y coordinate
 * @param {number} stepsToReach - Number of steps to reach this tile
 * @param {Array} bombs - Array of active bombs
 * @param {Array} allBombers - Array of all bombers
 * @param {Object} map - Game map
 * @param {number} currentSpeed - Current movement speed
 * @returns {number} - Safe time margin in ms (Infinity if no bombs nearby)
 */
export function getSafeTimeMargin(x, y, stepsToReach, bombs, allBombers, map, currentSpeed = 1) {
  const now = Date.now()
  const timePerGridCell = (GRID_SIZE / currentSpeed) * STEP_DELAY
  const alignmentOverhead = timePerGridCell * 0.5
  const timeToReach = stepsToReach * timePerGridCell + alignmentOverhead

  let minTimeMargin = Infinity

  for (const bomb of bombs) {
    if (bomb.isExploded) continue

    const owner = allBombers.find((b) => b.uid === bomb.uid)
    const range = owner ? owner.explosionRange : 2
    const { x: gridBombX, y: gridBombY } = toGridCoords(bomb.x, bomb.y)

    const bombCreatedAt = bomb.createdAt || now
    const bombLifeTime = bomb.lifeTime || BOMB_EXPLOSION_TIME
    const timeUntilExplosion = bombLifeTime - (now - bombCreatedAt)

    // Check if tile is bomb location or in blast zone
    let affectedByBomb = false

    if (x === gridBombX && y === gridBombY) {
      affectedByBomb = true
    } else {
      // Check explosion range
      for (const [dx, dy] of DIRS) {
        for (let step = 1; step <= range; step++) {
          const nx = gridBombX + dx * step
          const ny = gridBombY + dy * step

          if (!inBounds(nx, ny, map)) break
          if (BLOCKABLE_EXPLOSION.includes(map[ny][nx])) break

          if (nx === x && ny === y) {
            affectedByBomb = true
            break
          }
        }
        if (affectedByBomb) break
      }
    }

    if (affectedByBomb) {
      // Calculate margin: time until explosion - time to reach
      const margin = timeUntilExplosion - timeToReach
      minTimeMargin = Math.min(minTimeMargin, margin)
    }
  }

  return minTimeMargin
}
