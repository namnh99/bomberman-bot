import {
  GRID_SIZE,
  DIRS,
  BLOCKABLE_EXPLOSION,
  BOMB_EXPLOSION_TIME,
  STEP_DELAY,
} from "../../utils/constants.js"
import { inBounds } from "../../utils/gridUtils.js"
import { getBombWithGrid, getBombRange } from "../../utils/bombUtils.js"

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

  // WebSocket has low latency (~10-50ms typically)
  // EMERGENCY MODE: Use minimal buffers for desperate situations
  // NORMAL MODE: Balanced buffers for safety
  const speedSafetyFactor = Math.max(1, 2 / currentSpeed) // Slower = higher factor
  const networkBuffer = emergencyMode
    ? 100 * speedSafetyFactor // EMERGENCY: 100-200ms (WebSocket optimized)
    : 150 * speedSafetyFactor // NORMAL: 150-300ms (WebSocket optimized)

  // Debug logging for timing calculations (only log first few checks)
  if (stepsToReach <= 3 && bombs.length > 0) {
    console.log(
      `      🕐 Timing check [${x},${y}]: ${stepsToReach} steps @ speed ${currentSpeed} = ${timeToReach.toFixed(0)}ms (${timePerGridCell.toFixed(0)}ms/grid + ${alignmentOverhead.toFixed(0)}ms align)`,
    )
  }

  // Check each bomb to see if it will explode before we reach this tile
  for (const bomb of bombs) {
    const { gridX, gridY } = getBombWithGrid(bomb)
    const range = getBombRange(bomb, allBombers)

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
          `         💣 Bomb [${gridX},${gridY}]: SKIPPED (already exploded: elapsed ${elapsedTime}ms >= life ${bombLifeTime}ms)`,
        )
      }
      continue // Skip this bomb - it should be gone
    }

    const timeUntilExplosion = bombLifeTime - elapsedTime

    // DEBUG: Log timing calculations for first few tiles
    if (stepsToReach <= 3 && bombs.length > 0) {
      console.log(
        `         💣 Bomb [${gridX},${gridY}]: created=${bombCreatedAt}, life=${bombLifeTime}ms, now=${now}`,
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
    if (x === gridX && y === gridY) {
      // Only allow crossing the bomb tile if we can pass BEFORE it explodes
      // EMERGENCY: Minimal buffer (600ms) - desperate situations
      // NORMAL: Balanced buffer (1000ms) - safe crossing with reasonable margin
      const BOMB_TILE_BUFFER = emergencyMode
        ? 600 + networkBuffer // EMERGENCY: 700-800ms (WebSocket optimized)
        : 1000 + networkBuffer // NORMAL: 1150-1300ms (WebSocket optimized)
      const canCrossSafely =
        timeUntilExplosion > 0 && timeToReach < timeUntilExplosion - BOMB_TILE_BUFFER

      if (stepsToReach <= 3 && bombs.length > 0) {
        console.log(
          `         💣 Bomb at [${gridX},${gridY}] explodes in ${timeUntilExplosion.toFixed(0)}ms | Crossing tile needs ${timeToReach.toFixed(0)}ms + ${BOMB_TILE_BUFFER.toFixed(0)}ms buffer → ${canCrossSafely ? "✅ SAFE" : "❌ UNSAFE"}`,
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
        const nx = gridX + dx * step
        const ny = gridY + dy * step

        if (!inBounds(nx, ny)) break
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
      // EMERGENCY: Minimal buffer (400ms) + crossing time - desperate escape
      // NORMAL: Balanced buffer (600ms) + crossing time - safe crossing
      const SAFETY_BUFFER = emergencyMode
        ? 400 + networkBuffer + crossingTime // EMERGENCY: ~1.3-1.5s (WebSocket optimized)
        : 600 + networkBuffer + crossingTime // NORMAL: ~1.5-1.7s (WebSocket optimized)
      const canPassSafely =
        timeUntilExplosion > 0 && timeToReach < timeUntilExplosion - SAFETY_BUFFER

      if (stepsToReach <= 3 && bombs.length > 0) {
        console.log(
          `         💥 Tile in blast zone of [${gridX},${gridY}] | Need ${timeToReach.toFixed(0)}ms + ${SAFETY_BUFFER.toFixed(0)}ms buffer vs ${timeUntilExplosion.toFixed(0)}ms available → ${canPassSafely ? "✅ SAFE" : "❌ UNSAFE"}`,
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
 * Check if a path will be safe by the time we reach it (considering bomb timers)
 * @param {Array} pathCoordinates - Array of path coordinates [{x, y}, ...]
 * @param {Array} bombs - Array of active bombs
 * @param {Array} bombers - Array of all bombers
 * @param {Object} map - Game map
 * @param {number} currentSpeed - Current movement speed (pixels per tick)
 * @param {string} pathType - Type of path for logging ("FOLLOW" or "ESCAPE")
 * @returns {boolean} - True if path will be safe when we reach it
 */
export function isPathSafeByTime(
  pathCoordinates,
  bombs,
  bombers,
  map,
  currentSpeed,
  pathType = "PATH",
) {
  // Check EVERY step in path with timing validation
  // No need for unsafeTiles pre-check - isTileSafeByTime already checks blast zones efficiently
  for (let i = 0; i < pathCoordinates.length; i++) {
    const coord = pathCoordinates[i]
    const stepNumber = i + 1

    // CRITICAL: Validate timing - can we pass through this tile safely?
    const isSafeByTiming = isTileSafeByTime(
      coord.x,
      coord.y,
      stepNumber,
      bombs,
      bombers,
      map,
      currentSpeed,
    )

    if (!isSafeByTiming) {
      console.log(
        `   ❌ ${pathType} Step ${stepNumber} at [${coord.x},${coord.y}] crosses bomb zone - TIMING UNSAFE!`,
      )
      return false
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
    const { gridX, gridY } = getBombWithGrid(bomb)
    const range = getBombRange(bomb, allBombers)

    const bombCreatedAt = bomb.createdAt || now
    const bombLifeTime = bomb.lifeTime || BOMB_EXPLOSION_TIME
    const timeUntilExplosion = bombLifeTime - (now - bombCreatedAt)

    // Check if tile is bomb location or in blast zone
    let affectedByBomb = false

    if (x === gridX && y === gridY) {
      affectedByBomb = true
    } else {
      // Check explosion range
      for (const [dx, dy] of DIRS) {
        for (let step = 1; step <= range; step++) {
          const nx = gridX + dx * step
          const ny = gridY + dy * step

          if (!inBounds(nx, ny)) break
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
