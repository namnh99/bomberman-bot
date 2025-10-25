import { GRID_SIZE, DIRS, WALKABLE, BREAKABLE, STEP_DELAY } from "../../utils/constants.js"
import { inBounds, posKey, toGridCoords, isWalkable } from "../../utils/gridUtils.js"
import { findUnsafeTiles, createBombTileMap } from "./dangerMap.js"
import { isTileSafeByTime } from "./safetyEvaluator.js"

/**
 * A unified BFS that finds the best path to a target, avoiding active bomb zones
 * and keeping track of breakable chests in the way.
 * @param {Array} map - Game map
 * @param {Object} start - Starting position {x, y}
 * @param {Array} targets - Array of target positions
 * @param {Array} bombs - Array of bombs
 * @param {Array} allBombers - Array of all bombers
 * @param {string} myUid - Current player UID
 * @param {boolean} isEscaping - Whether this is an escape path (allows crossing danger)
 * @returns {Object|null} {path: Array, walls: Array} or null if no path found
 */
/**
 * Find best path to targets, avoiding bomb zones
 * @param {Array} map - Game map
 * @param {Object} start - Start position {x, y}
 * @param {Array} targets - Target positions [{x, y}, ...]
 * @param {Array} bombs - Active bombs
 * @param {Array} allBombers - All bombers in game
 * @param {string} myUid - Player UID
 * @param {boolean} isEscaping - If true, can cross danger to reach safety
 * @param {boolean} allowTimingCrossing - If true, allow crossing bomb zones with timing checks (RISKY!)
 * @returns {Object|null} {path: Array, walls: Array} or null if no path found
 */
export function findBestPath(
  map,
  start,
  targets,
  bombs,
  allBombers,
  myUid,
  isEscaping = false,
  allowTimingCrossing = false,
) {
  const h = map.length
  const w = map[0].length
  const queue = [[start.x, start.y, [], [], 0]] // [x, y, path, walls, stepCount]
  const visited = new Set([posKey(start.x, start.y)])

  // Pre-calculate unsafe tiles for O(1) lookup
  const unsafeTiles = findUnsafeTiles(map, bombs, allBombers)
  // Create bomb tile map for checking walkable
  const bombTiles = createBombTileMap(bombs)

  // Get current speed for timing calculations
  const myBomber = allBombers.find((b) => b.uid === myUid)
  const currentSpeed = myBomber?.speed || 1

  while (queue.length) {
    const [x, y, path, walls, stepCount] = queue.shift()

    // Check if we've reached a target
    if (
      targets.some((t) => {
        if (isEscaping) return t.x === x && t.y === y && !unsafeTiles.has(posKey(t.x, t.y))
        return t.x === x && t.y === y
      })
    ) {
      return { path, walls }
    }

    // Explore neighbors
    for (const [dx, dy, dir] of DIRS) {
      const nx = x + dx
      const ny = y + dy
      const key = posKey(nx, ny)

      if (!inBounds(nx, ny, map) || visited.has(key)) {
        continue
      }

      // Check if tile is in bomb zone
      const isInBombZone = unsafeTiles.has(key)

      // PRIORITY 1: ALWAYS avoid bomb zones when not escaping (SAFE STRATEGY)
      if (!isEscaping && isInBombZone) {
        // Only allow crossing if explicitly enabled AND timing is safe
        if (allowTimingCrossing) {
          const nextStepCount = stepCount + 1
          const isSafeByTiming = isTileSafeByTime(
            nx,
            ny,
            nextStepCount,
            bombs,
            allBombers,
            map,
            currentSpeed,
          )

          if (!isSafeByTiming) {
            // Timing unsafe - absolutely avoid
            if (nextStepCount <= 3) {
              console.log(`      ⚠️  Avoiding bomb zone at [${nx}, ${ny}] - timing unsafe`)
            }
            continue
          }
          // If safe by timing, allow passage (RISKY!)
          if (nextStepCount <= 3) {
            console.log(
              `      ⚠️  RISKY: Crossing bomb zone at [${nx}, ${ny}] - timing calculated as safe`,
            )
          }
        } else {
          // Default: NEVER cross bomb zones (SAFE STRATEGY)
          continue
        }
      }

      // Block bomb tiles based on walkable flag
      const bombAtTile = bombTiles.get(key)
      if (bombAtTile && !bombAtTile.walkable) {
        continue
      }

      // When escaping, only prevent going from safe to unsafe
      if (isEscaping) {
        const isCurrentTileSafe = !unsafeTiles.has(posKey(x, y))
        if (isCurrentTileSafe && unsafeTiles.has(key)) {
          continue
        }
      }

      const cell = map[ny][nx]
      if (WALKABLE.includes(cell)) {
        visited.add(key)
        const newPath = [...path, dir]
        const newWalls = BREAKABLE.includes(cell) ? [...walls, { x: nx, y: ny }] : walls
        queue.push([nx, ny, newPath, newWalls, stepCount + 1])
      }
    }
  }

  return null
}

/**
 * SAFE PATHFINDING WRAPPER
 * Try to find path avoiding bomb zones first (SAFE)
 * If no path found, retry with timing-based crossing (RISKY - last resort)
 */
export function findSafePath(map, start, targets, bombs, allBombers, myUid) {
  // ATTEMPT 1: Find path AVOIDING all bomb zones (SAFE STRATEGY)
  const safePath = findBestPath(map, start, targets, bombs, allBombers, myUid, false, false)

  if (safePath) {
    console.log(
      `   ✅ Safe path found: ${safePath.path.join(" → ")} (${safePath.path.length} steps)`,
    )
    return safePath
  }

  // ATTEMPT 2: No safe path - try with timing-based crossing (RISKY!)
  const riskyPath = findBestPath(map, start, targets, bombs, allBombers, myUid, false, true)

  if (riskyPath) {
    console.log(
      `   ⚠️  RISKY path found: ${riskyPath.path.join(" → ")} (${riskyPath.path.length} steps) - crosses bomb zones!`,
    )
    return riskyPath
  }

  return null
}

/**
 * Find the FASTEST path to the nearest safe tile using optimized BFS
 * Returns immediately when first safe tile is found (guaranteed shortest)
 * Considers bomb explosion times - allows crossing danger zones if we can reach safety in time
 * @param {Array} map - Game map
 * @param {Object} start - Starting position {x, y}
 * @param {Array} bombs - Array of bombs
 * @param {Array} allBombers - Array of all bombers
 * @param {Object} myBomber - Current player's bomber object
 * @param {boolean} strictMode - If true, NEVER cross bomb zones (for critical escapes)
 * @returns {Object|null} {path: Array, target: Object, distance: number} or null
 */
export function findShortestEscapePath(
  map,
  start,
  bombs,
  allBombers,
  myBomber,
  strictMode = false,
) {
  const h = map.length
  const w = map[0].length
  const currentSpeed = myBomber.speed || 1

  const bombTiles = createBombTileMap(bombs)
  const unsafeTiles = strictMode ? findUnsafeTiles(map, bombs, allBombers) : new Set()

  // BFS queue: [x, y, path, stepCount]
  const queue = [[start.x, start.y, [], 0]]
  const visited = new Set([posKey(start.x, start.y)])

  while (queue.length) {
    const [x, y, path, stepCount] = queue.shift()

    const key = posKey(x, y)
    const bombAtCurrentTile = bombTiles.get(key)

    // In strict mode, NEVER consider unsafe tiles as escape destinations
    if (strictMode && unsafeTiles.has(key) && path.length > 0) {
      continue
    }

    // Check if current position will be safe considering bomb timers
    const willBeSafe = strictMode
      ? !unsafeTiles.has(key)
      : isTileSafeByTime(x, y, stepCount, bombs, allBombers, map, currentSpeed)

    if (willBeSafe) {
      // Only consider it a valid escape destination if it's NOT a bomb tile
      if (!bombAtCurrentTile && path.length > 0) {
        // Calculate detailed timing for the escape path
        const timePerGridCell = (GRID_SIZE / currentSpeed) * STEP_DELAY
        const alignmentOverhead = timePerGridCell * 0.5
        const totalTime = stepCount * timePerGridCell + alignmentOverhead

        console.log(
          `   🕐 Found ${strictMode ? "STRICT" : "time-safe"} escape to [${x}, ${y}] in ${stepCount} steps`,
        )
        console.log(
          `      ⏱️  Total escape time: ${stepCount} × ${timePerGridCell.toFixed(0)}ms + ${alignmentOverhead.toFixed(0)}ms align = ${totalTime.toFixed(0)}ms @ speed ${currentSpeed}`,
        )
        console.log(`      📍 Path: ${path.join(" → ")}`)

        return { path, target: { x, y }, distance: path.length }
      }
    } else if (path.length === 0) {
      return null
    } else {
      continue
    }

    // Explore all 4 directions
    for (const [dx, dy, dir] of DIRS) {
      const nx = x + dx
      const ny = y + dy
      const key = posKey(nx, ny)

      if (!inBounds(nx, ny, map) || visited.has(key)) {
        continue
      }

      // CRITICAL: Never move into a tile with a bomb (except if walkable flag set)
      const bombAtNextTile = bombTiles.get(key)
      if (bombAtNextTile && !bombAtNextTile.walkable) {
        continue
      }

      // In strict mode, NEVER cross bomb zones during escape
      if (strictMode && unsafeTiles.has(key)) {
        continue
      }

      const cell = map[ny][nx]

      // Only walk through empty spaces and items
      if (WALKABLE.includes(cell)) {
        visited.add(key)
        queue.push([nx, ny, [...path, dir], stepCount + 1])
      }
    }
  }

  return null
}
