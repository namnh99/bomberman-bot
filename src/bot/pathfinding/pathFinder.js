import { GRID_SIZE, DIRS, WALKABLE, BREAKABLE, STEP_DELAY } from "../../utils/constants.js"
import { inBounds, posKey, toGridCoords, isWalkable } from "../../utils/gridUtils.js"
import { findUnsafeTiles, createBombTileMap } from "./dangerMap.js"
import { isTileSafeByTime, getSafeTimeMargin } from "./safetyEvaluator.js"

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
  // CRITICAL: Always calculate unsafe tiles for destination validation
  // strictMode only affects intermediate tiles, not final destination check
  const unsafeTiles = findUnsafeTiles(map, bombs, allBombers)

  // For exit validation, only use REAL bombs (exclude future bombs that haven't been placed yet)
  // RELIABLE METHOD: Real bombs from server DON'T have isFuture flag
  // Future bombs created by createFutureBomb() have isFuture=true
  const realBombs = bombs.filter((b) => !b.isFuture)
  const futureBombs = bombs.filter((b) => b.isFuture)
  const unsafeTilesFromRealBombs = findUnsafeTiles(map, realBombs, allBombers)

  // If ALL bombs are real (no future bombs), we MUST allow escaping through blast zones
  // Otherwise bot gets stuck in ping-pong when surrounded by its own bombs
  const hasFutureBombs = futureBombs.length > 0

  // BFS queue: [x, y, path, stepCount]
  const queue = [[start.x, start.y, [], 0]]
  const visited = new Set([posKey(start.x, start.y)])

  let exploredCount = 0
  while (queue.length) {
    const [x, y, path, stepCount] = queue.shift()
    exploredCount++

    const key = posKey(x, y)
    const bombAtCurrentTile = bombTiles.get(key)

    // In strict mode, NEVER consider unsafe tiles as escape destinations
    if (strictMode && unsafeTiles.has(key) && path.length > 0) {
      continue
    }

    // Check if current position will be safe considering bomb timers
    // For escape DESTINATION, timing safety is the PRIMARY criterion
    const willBeSafe = strictMode
      ? !unsafeTiles.has(key)
      : isTileSafeByTime(x, y, stepCount, bombs, allBombers, map, currentSpeed)

    // RELAXED CHECK: In non-strict mode, ALLOW blast zones if timing is safe
    // This fixes the issue where bot can't find escape because all nearby tiles
    // are in blast zones but have enough time to escape
    // In strict mode, we still require tiles outside blast zones for extra safety
    const isOutsideBlastZones = strictMode ? !unsafeTilesFromRealBombs.has(key) : true

    // Allow starting position to always be in blast zone
    const isStartingPosition = path.length === 0

    if (willBeSafe && (isOutsideBlastZones || isStartingPosition)) {
      // Starting position (path.length === 0): Always explore neighbors to find escape
      // Non-starting position: Validate as potential escape destination
      if (path.length === 0) {
        // Starting position - skip validation, just explore neighbors below
      } else if (!bombAtCurrentTile) {
        // Potential escape destination - validate it has safe exits
        // CRITICAL: Check if this tile is OUTSIDE ALL BLAST ZONES (including future bombs!)
        // If yes, bot can safely STAY here without needing further exits
        // MUST use unsafeTiles (all bombs) NOT unsafeTilesFromRealBombs (real only)
        const isOutsideAllBlastZones = !unsafeTiles.has(key)

        if (isOutsideAllBlastZones) {
          // Tile is outside all blast zones - bot can stay here safely!
          console.log(
            `   ✅ Escape tile [${x}, ${y}] is OUTSIDE all blast zones - safe to stay (no exit check needed)`,
          )
        } else {
          // Tile is in blast zone - MUST verify it has timing-safe exits
          // CRITICAL: Verify this escape destination has at least ONE walkable exit
          // that will also be TIMING-SAFE when bot arrives
          // This prevents escaping to dead-ends where bot gets trapped later
          let hasValidExit = false
          const exitDetails = []

          // Assume bot needs 1 more step to exit from this position
          const exitStepCount = stepCount + 1

          for (const [dx, dy, dirName] of DIRS) {
            const exitX = x + dx
            const exitY = y + dy

            if (!inBounds(exitX, exitY, map)) {
              exitDetails.push(`[${exitX},${exitY}]=OUT_OF_BOUNDS`)
              continue
            }

            const exitCell = map[exitY][exitX]
            const isWalkable = WALKABLE.includes(exitCell)

            // Check if there's a bomb at this exit position
            const hasBomb = bombTiles.has(posKey(exitX, exitY))

            // CRITICAL: Check if exit is OUTSIDE blast zones
            // If yes, it's ALWAYS valid (bot can stay there safely)
            const exitOutsideBlastZones = !unsafeTiles.has(posKey(exitX, exitY))

            // CRITICAL: Check if this exit will be timing-safe when bot can reach it
            // This prevents escaping to tiles that become dead-ends
            const exitTimingSafe = isTileSafeByTime(
              exitX,
              exitY,
              exitStepCount,
              bombs,
              allBombers,
              map,
              currentSpeed,
            )

            exitDetails.push(
              `[${exitX},${exitY}]=${exitCell}(walk:${isWalkable},bomb:${hasBomb},outside:${exitOutsideBlastZones},timingSafe:${exitTimingSafe})`,
            )

            // Valid exit conditions:
            // 1. Walkable AND no bomb AND (OUTSIDE blast zones OR timing-safe)
            // This allows escaping to tiles in blast zones IF timing is safe
            // OR escaping to tiles outside blast zones (always safe)
            if (isWalkable && !hasBomb && (exitOutsideBlastZones || exitTimingSafe)) {
              hasValidExit = true
              break
            }
          }

          if (!hasValidExit) {
            console.log(
              `   ⚠️ Escape tile [${x}, ${y}] is TRAPPED (no timing-safe exits available) - skipping`,
            )
            console.log(`      Exit check: ${exitDetails.join(", ")}`)
            continue // Don't use this as escape destination
          }
        }

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

      if (!inBounds(nx, ny, map)) {
        if (exploredCount <= 3) {
          console.log(`      [${x},${y}] → ${dir} [${nx},${ny}]: OUT_OF_BOUNDS`)
        }
        continue
      }

      if (visited.has(key)) {
        if (exploredCount <= 3) {
          console.log(`      [${x},${y}] → ${dir} [${nx},${ny}]: ALREADY_VISITED`)
        }
        continue
      }

      // CRITICAL: Never move into a tile with a bomb (except if walkable flag set)
      const bombAtNextTile = bombTiles.get(key)
      if (bombAtNextTile && !bombAtNextTile.walkable) {
        if (exploredCount <= 3) {
          console.log(`      [${x},${y}] → ${dir} [${nx},${ny}]: HAS_BOMB`)
        }
        continue
      }

      // In strict mode, NEVER cross bomb zones during escape
      if (strictMode && unsafeTiles.has(key)) {
        if (exploredCount <= 3) {
          console.log(`      [${x},${y}] → ${dir} [${nx},${ny}]: IN_BLAST_ZONE (strict mode)`)
        }
        continue
      }

      const cell = map[ny][nx]

      // Only walk through empty spaces and items
      if (WALKABLE.includes(cell)) {
        if (exploredCount <= 3) {
          console.log(`      [${x},${y}] → ${dir} [${nx},${ny}]: ✅ ADDED TO QUEUE (cell=${cell})`)
        }
        visited.add(key)
        queue.push([nx, ny, [...path, dir], stepCount + 1])
      } else {
        if (exploredCount <= 3) {
          console.log(`      [${x},${y}] → ${dir} [${nx},${ny}]: NOT_WALKABLE (cell=${cell})`)
        }
      }
    }
  }

  console.log(`   🔍 BFS exhausted after exploring ${exploredCount} tiles - NO ESCAPE FOUND`)
  console.log(`      Real bombs: ${realBombs.length}/${bombs.length} total bombs`)
  console.log(`      Unsafe tiles from real bombs: ${unsafeTilesFromRealBombs.size}`)
  console.log(`      All unsafe tiles: ${unsafeTiles.size}`)
  return null
}
