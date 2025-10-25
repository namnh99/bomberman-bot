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
export function findBestPath(map, start, targets, bombs, allBombers, myUid, isEscaping = false) {
  const h = map.length
  const w = map[0].length
  const queue = [[start.x, start.y, [], []]] // [x, y, path, walls]
  const visited = new Set([posKey(start.x, start.y)])

  // Pre-calculate unsafe tiles for O(1) lookup
  const unsafeTiles = findUnsafeTiles(map, bombs, allBombers)
  // Create bomb tile map for checking walkable
  const bombTiles = createBombTileMap(bombs)

  while (queue.length) {
    const [x, y, path, walls] = queue.shift()

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

      // When not escaping, NEVER enter bomb zones
      if (!isEscaping && unsafeTiles.has(key)) {
        console.log(`   ⚠️  Avoiding bomb zone at [${nx}, ${ny}] while pathfinding`)
        continue
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
        queue.push([nx, ny, newPath, newWalls])
      }
    }
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
 * @returns {Object|null} {path: Array, target: Object, distance: number} or null
 */
export function findShortestEscapePath(map, start, bombs, allBombers, myBomber) {
  const h = map.length
  const w = map[0].length
  const currentSpeed = myBomber.speed || 1

  const bombTiles = createBombTileMap(bombs)

  // BFS queue: [x, y, path, stepCount]
  const queue = [[start.x, start.y, [], 0]]
  const visited = new Set([posKey(start.x, start.y)])

  while (queue.length) {
    const [x, y, path, stepCount] = queue.shift()

    const key = posKey(x, y)
    const bombAtCurrentTile = bombTiles.get(key)

    // Check if current position will be safe considering bomb timers
    const willBeSafe = isTileSafeByTime(x, y, stepCount, bombs, allBombers, map, currentSpeed)

    if (willBeSafe) {
      // Only consider it a valid escape destination if it's NOT a bomb tile
      if (!bombAtCurrentTile && path.length > 0) {
        console.log(
          `   🕐 Found time-safe escape to [${x}, ${y}] in ${stepCount} steps (${(((stepCount * GRID_SIZE) / currentSpeed) * STEP_DELAY).toFixed(0)}ms)`,
        )
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
