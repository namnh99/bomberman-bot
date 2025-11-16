import { DIRS, WALKABLE, BREAKABLE } from "../../utils/constants.js"
import { inBounds, posKey } from "../../utils/gridUtils.js"
import { findUnsafeTiles, createBombTileMap, findSafeTiles } from "./dangerMap.js"
import { isTileSafeByTime } from "./safetyEvaluator.js"

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
 * @returns {Object|null} {path: Array, fullPathCoordinates: Array, walls: Array} or null if no path found
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
  const queue = [[start.x, start.y, [], [], [], 0]] // [x, y, path, pathCoordinates, walls, stepCount]
  const visited = new Set([posKey(start.x, start.y)])

  // Pre-calculate unsafe tiles for O(1) lookup
  const unsafeTiles = findUnsafeTiles(map, bombs, allBombers)
  // Create bomb tile map for checking walkable
  const bombTiles = createBombTileMap(bombs)

  // Get current speed for timing calculations
  const myBomber = allBombers.find((b) => b.uid === myUid)
  const currentSpeed = myBomber?.speed || 1

  while (queue.length) {
    const [x, y, path, pathCoordinates, walls, stepCount] = queue.shift()

    // Check if we've reached a target
    if (
      targets.some((t) => {
        if (isEscaping) return t.x === x && t.y === y && !unsafeTiles.has(posKey(t.x, t.y))
        return t.x === x && t.y === y
      })
    ) {
      return { path, fullPathCoordinates: pathCoordinates || [], walls }
    }

    // Explore neighbors
    for (const [dx, dy, dir] of DIRS) {
      const nx = x + dx
      const ny = y + dy
      const key = posKey(nx, ny)

      if (!inBounds(nx, ny) || visited.has(key)) {
        continue
      }

      // Check if tile is in bomb zone
      const isInBombZone = unsafeTiles.has(key)

      // CRITICAL: ALWAYS validate timing when crossing bomb zones
      // Even when escaping, we MUST check if we can pass through safely
      if (isInBombZone) {
        // Only allow crossing if explicitly enabled AND timing is safe
        if (allowTimingCrossing || isEscaping) {
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
            }
            continue
          }
          // If safe by timing, allow passage (RISKY!)
          if (nextStepCount <= 3) {
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
        const newPathCoordinates = [...pathCoordinates, { x: nx, y: ny }]
        const newWalls = BREAKABLE.includes(cell) ? [...walls, { x: nx, y: ny }] : walls
        queue.push([nx, ny, newPath, newPathCoordinates, newWalls, stepCount + 1])
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
    return safePath
  }

  // ATTEMPT 2: No safe path - try with timing-based crossing (RISKY!)
  const riskyPath = findBestPath(map, start, targets, bombs, allBombers, myUid, false, true)

  if (riskyPath) {
    return riskyPath
  }

  return null
}

export function findShortestEscapePath(map, start, bombs, allBombers, myBomber) {
  const safeTiles = findSafeTiles(map, bombs, allBombers)
  const safePath = findBestPath(map, start, safeTiles, bombs, allBombers, myBomber.uid, true, true)

  if (!safePath) return null

  return {
    ...safePath,
    target: safePath.fullPathCoordinates[safePath.fullPathCoordinates.length - 1],
  }
}
