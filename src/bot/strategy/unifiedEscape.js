import { DIRS, GRID_SIZE, STEP_DELAY } from "../../utils/constants.js"
import { posKey, isWalkable, manhattanDistance } from "../../utils/gridUtils.js"
import { getBombWithGrid, getBombRange } from "../../utils/bombUtils.js"
import { findSafeTiles, findUnsafeTiles } from "../pathfinding/dangerMap.js"
import { findBestPath } from "../pathfinding/pathFinder.js"
import { isTileSafeByTime } from "../pathfinding/safetyEvaluator.js"
import { findWaveSurfingPath, getWaveSurfingDirection } from "../pathfinding/waveSurfing.js"

/**
 * UNIFIED ESCAPE SYSTEM
 *
 * Single escape, integrate all strategies:
 * - Wave Surfing (4+ bombs)
 * - Staged Escape (2-3 bombs with timing differences)
 * - Path-based Escape (standard BFS)
 * - Emergency Moves (desperate situations)
 *
 * Anti-ping-pong protection included
 */

// Anti-ping-pong tracking
let lastEscapeFrom = null
let lastEscapeTo = null
let lastEscapeTime = 0
const REVERSAL_COOLDOWN = 2000 // 2s

/**
 * Main escape function - single entry point
 */
export function findEscapeAction(map, player, bombs, bombers, myUid) {
  const myBomber = bombers.find((b) => b.uid === myUid)
  const currentSpeed = myBomber?.speed || 1


  // Filter relevant bombs (within 8 tiles)
  const nearbyBombs = bombs.filter((bomb) => {
    const { gridX, gridY } = getBombWithGrid(bomb)
    const distance = manhattanDistance(gridX, gridY, player.x, player.y)
    return distance <= 8
  })

  if (nearbyBombs.length === 0) {
    return null
  }


  // PRIORITY 1: Wave Surfing (4+ bombs)
  if (nearbyBombs.length >= 4) {
    const surfResult = tryWaveSurfing(player, bombs, map, bombers, myUid)
    if (surfResult) return surfResult
  }

  // PRIORITY 2: Standard Path Escape (ALWAYS TRY TO MOVE FIRST!)
  // Try to find a path to complete safety before considering STAY
  const pathResult = tryPathEscape(player, map, bombs, bombers, myUid)
  if (pathResult) return pathResult

  // PRIORITY 3: Staged Escape (FALLBACK - only if no path found)
  // Only STAY if we cannot find any escape path
  if (nearbyBombs.length >= 2 && nearbyBombs.length <= 3) {
    const stagedResult = tryStagedEscape(player, map, bombs, bombers, myUid)
    if (stagedResult) return stagedResult
  }

  // PRIORITY 4: Emergency Timing Direction (3+ bombs, path failed)
  if (nearbyBombs.length >= 3) {
    const timingResult = tryTimingDirection(player, map, bombs, bombers, myUid)
    if (timingResult) return timingResult
  }

  // PRIORITY 5: Emergency Moves (desperate)
  return tryEmergencyMoves(player, map, bombs, bombers, currentSpeed)
}

/**
 * PRIORITY 1: Wave Surfing for complex multi-bomb scenarios
 */
function tryWaveSurfing(player, bombs, map, bombers, myUid) {
  // Count nearby bombs using grid coordinates
  const nearbyCount = bombs.filter((b) => {
    const { gridX, gridY } = getBombWithGrid(b)
    const distance = manhattanDistance(gridX, gridY, player.x, player.y)
    return distance <= 8
  }).length


  const surfPath = findWaveSurfingPath(player, bombs, map, bombers, myUid)

  if (!surfPath || !surfPath.target) return null

  // If wave surfing has direct path, use it
  if (surfPath.path && surfPath.path.length > 0) {
    return {
      action: surfPath.path[0],
      strategy: "wave_surfing",
      fullPath: surfPath.path,
    }
  }

  // Otherwise, pathfind to surfing target
  const pathToTarget = findBestPath(map, player, [surfPath.target], bombs, bombers, myUid, true)

  if (pathToTarget && pathToTarget.path.length > 0) {
    return {
      action: pathToTarget.path[0],
      strategy: "wave_surfing_assisted",
      fullPath: pathToTarget.path,
    }
  }

  return null
}

/**
 * PRIORITY 2: Staged Escape - wait for fast bomb to explode
 */
function tryStagedEscape(player, map, bombs, bombers, myUid) {
  // Sort bombs by explosion time
  const sortedBombs = bombs
    .map((b) => ({
      ...b,
      gridX: Math.floor(b.x / GRID_SIZE),
      gridY: Math.floor(b.y / GRID_SIZE),
      timeRemaining: b.lifeTime - (Date.now() - b.createdAt),
    }))
    .sort((a, b) => a.timeRemaining - b.timeRemaining)

  const fastestBomb = sortedBombs[0]
  const slowestBomb = sortedBombs[sortedBombs.length - 1]

  // Only use staged escape if there's significant timing difference
  const timeDiff = slowestBomb.timeRemaining - fastestBomb.timeRemaining

  if (timeDiff < 1000 || fastestBomb.timeRemaining > 3500 || fastestBomb.timeRemaining < 400) {
    return null // Not suitable for staged escape
  }


  const unsafeFromFastest = findUnsafeTiles(map, [fastestBomb], bombers)
  const currentKey = posKey(player.x, player.y)

  // Check if current position is safe from fastest bomb
  if (!unsafeFromFastest.has(currentKey)) {
    const unsafeFromAll = findUnsafeTiles(map, bombs, bombers)

    // If completely safe from ALL bombs, don't need staged escape
    if (!unsafeFromAll.has(currentKey)) {
      return null // Let path escape handle movement to better positions
    }

    // If safe from fast bomb but in slow bomb zone:
    // 1. First try to find a path to complete safety (already tried in pathEscape)
    // 2. Only STAY if we already verified no escape path exists
    const remainingBombs = sortedBombs.slice(1)
    if (canEscapeAfterWaiting(player, remainingBombs, map, bombers, myUid)) {
      return {
        action: "STAY",
        strategy: "staged_wait",
      }
    }
  }

  // Find position safe from fastest bomb
  const waitPos = findWaitingPosition(player, fastestBomb, bombs, map, bombers, myUid)

  if (!waitPos) return null

  // Path to waiting position
  const pathToWait = findBestPath(map, player, [waitPos], bombs, bombers, myUid, false)

  if (pathToWait && pathToWait.path.length > 0) {
    return {
      action: pathToWait.path[0],
      strategy: "staged_move",
      fullPath: pathToWait.path,
    }
  }

  return null
}

/**
 * Find waiting position safe from fastest bomb
 */
function findWaitingPosition(myPos, fastestBomb, allBombs, map, bombers, myUid) {
  const myBomber = bombers.find((b) => b.uid === myUid)
  const speed = myBomber?.speed || 1

  const unsafeFromFastest = findUnsafeTiles(map, [fastestBomb], bombers)
  const unsafeFromAll = findUnsafeTiles(map, allBombs, bombers)

  const candidates = []

  // Search radius 1-6
  for (let r = 1; r <= 6; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.abs(dx) + Math.abs(dy) !== r) continue

        const x = myPos.x + dx
        const y = myPos.y + dy
        const key = posKey(x, y)

        // Must be in bounds and walkable
        if (y < 0 || y >= map.length || x < 0 || x >= map[0].length) continue
        if (!isWalkable(x, y, map)) continue

        // Must be safe from fastest bomb
        if (unsafeFromFastest.has(key)) continue

        // Check if reachable in time
        const dist = Math.abs(dx) + Math.abs(dy)
        const travelTime = dist * (GRID_SIZE / speed) * STEP_DELAY

        if (travelTime + 200 > fastestBomb.timeRemaining) continue

        // Check if has escape routes from remaining bombs
        const remainingBombs = allBombs.filter((b) => b !== fastestBomb)
        if (!canEscapeAfterWaiting({ x, y }, remainingBombs, map, bombers, myUid)) continue

        // Score: prefer closer, completely safe positions
        const isCompletelySafe = !unsafeFromAll.has(key)
        const score = (isCompletelySafe ? 10000 : 0) + (10 - dist) * 100

        candidates.push({ x, y, score })
      }
    }
  }

  if (candidates.length === 0) return null

  candidates.sort((a, b) => b.score - a.score)
  return candidates[0]
}

/**
 * Check if position has escape routes after waiting
 */
function canEscapeAfterWaiting(pos, remainingBombs, map, bombers, myUid) {
  const unsafeFromRemaining = findUnsafeTiles(map, remainingBombs, bombers)
  const key = posKey(pos.x, pos.y)

  // If completely safe, no need to escape
  if (!unsafeFromRemaining.has(key)) return true

  // Check if at least one neighbor is safe or safe-by-timing
  const myBomber = bombers.find((b) => b.uid === myUid)
  const speed = myBomber?.speed || 1

  for (const [dx, dy] of DIRS) {
    const nx = pos.x + dx
    const ny = pos.y + dy

    if (!isWalkable(nx, ny, map)) continue

    const nKey = posKey(nx, ny)

    // Safe neighbor found
    if (!unsafeFromRemaining.has(nKey)) return true

    // Check timing safety
    if (isTileSafeByTime(nx, ny, 1, remainingBombs, bombers, map, speed)) {
      return true
    }
  }

  return false
}

/**
 * PRIORITY 3: Standard path-based escape
 */
function tryPathEscape(player, map, bombs, bombers, myUid) {

  const myBomber = bombers.find((b) => b.uid === myUid)
  const safeTiles = findSafeTiles(map, bombs, bombers, myBomber)

  if (safeTiles.length === 0) {
    return null
  }

  // Anti-ping-pong: filter out recent escape positions
  const now = Date.now()
  const filteredSafe = filterRecentEscapes(safeTiles, now)

  const targets = filteredSafe.length > 0 ? filteredSafe : safeTiles
  const pathResult = findBestPath(map, player, targets, bombs, bombers, myUid, true)

  if (!pathResult || !pathResult.path || pathResult.path.length === 0) {
    return null
  }


  // Track escape for anti-ping-pong
  trackEscape(player, pathResult.path[0], now)

  return {
    action: pathResult.path[0],
    strategy: "path_escape",
    fullPath: pathResult.path,
  }
}

/**
 * PRIORITY 4: Timing-based direction (Wave Surfing fallback)
 */
function tryTimingDirection(player, map, bombs, bombers, myUid) {

  const direction = getWaveSurfingDirection(player, bombs, map, bombers, myUid)

  if (!direction) {
    return null
  }


  return {
    action: direction,
    strategy: "timing_direction",
    fullPath: [direction],
  }
}

/**
 * PRIORITY 5: Emergency moves (last resort)
 */
function tryEmergencyMoves(player, map, bombs, bombers, currentSpeed) {

  const unsafeTiles = findUnsafeTiles(map, bombs, bombers)

  // Check if current position is safe
  const currentKey = posKey(player.x, player.y)
  const currentPositionSafe = !unsafeTiles.has(currentKey)

  const moves = []

  // Calculate distance from bombs for each direction
  for (const [dx, dy, dir] of DIRS) {
    const nx = player.x + dx
    const ny = player.y + dy

    if (!isWalkable(nx, ny, map)) continue

    const key = posKey(nx, ny)

    // Don't move onto bomb
    const isBombTile = bombs.some((b) => {
      const { gridX, gridY } = getBombWithGrid(b)
      return gridX === nx && gridY === ny
    })
    if (isBombTile) continue

    // Calculate min distance to any bomb AND check if outside blast range
    let minDist = Infinity
    let isOutsideAllBlastZones = true

    for (const bomb of bombs) {
      const { gridX, gridY } = getBombWithGrid(bomb)
      const distance = manhattanDistance(nx, ny, gridX, gridY)
      minDist = Math.min(minDist, distance)

      // Check if this position is outside this bomb's blast range
      const bombRange = getBombRange(bomb, bombers)
      if (distance <= bombRange) {
        isOutsideAllBlastZones = false
      }
    }

    // Check if safe by timing
    const isSafeByTime = isTileSafeByTime(nx, ny, 1, bombs, bombers, map, currentSpeed, true)

    // Check if currently safe
    const isCurrentlySafe = !unsafeTiles.has(key)

    moves.push({
      dir,
      nx,
      ny,
      minDist,
      isOutsideAllBlastZones,
      isSafeByTime,
      isCurrentlySafe,
      // Score: Prioritize outside blast zones > safe by timing > currently safe > distance
      score:
        (isOutsideAllBlastZones ? 20000 : 0) +
        (isSafeByTime ? 10000 : 0) +
        (isCurrentlySafe ? 5000 : 0) +
        minDist * 100,
    })
  }

  // Filter anti-ping-pong
  const now = Date.now()
  const filteredMoves = filterRecentEscapeMoves(moves, now)

  const availableMoves = filteredMoves.length > 0 ? filteredMoves : moves

  if (availableMoves.length === 0) {
    return { action: "STAY", strategy: "emergency_stay" }
  }

  // CRITICAL: Filter out moves that are NOT safe by timing
  // Don't move into blast zones when bombs about to explode!
  const safeMoves = availableMoves.filter((move) => move.isSafeByTime)

  if (safeMoves.length === 0) {
    // If current position is safe, STAY is better than moving to unsafe position!
    if (currentPositionSafe) {
      return { action: "STAY", strategy: "emergency_stay_safe_position" }
    }

    return { action: "STAY", strategy: "emergency_stay_trapped" }
  }

  // Sort by score (prioritize outside blast zones + safe by timing + distance)
  safeMoves.sort((a, b) => b.score - a.score)
  const best = safeMoves[0]


  // Track for anti-ping-pong
  trackEscapeMove(player, best.dir, now)

  return {
    action: best.dir,
    strategy: "emergency_move",
    fullPath: [best.dir],
  }
}

/**
 * Anti-ping-pong: Filter out recent escape positions
 */
function filterRecentEscapes(safeTiles, now) {
  if (!lastEscapeFrom || !lastEscapeTo || now - lastEscapeTime > REVERSAL_COOLDOWN) {
    return safeTiles
  }

  return safeTiles.filter((tile) => {
    const key = posKey(tile.x, tile.y)
    return key !== lastEscapeFrom && key !== lastEscapeTo
  })
}

/**
 * Anti-ping-pong: Filter out moves to recent positions
 */
function filterRecentEscapeMoves(moves, now) {
  if (!lastEscapeFrom || !lastEscapeTo || now - lastEscapeTime > REVERSAL_COOLDOWN) {
    return moves
  }

  return moves.filter((move) => {
    const key = posKey(move.nx, move.ny)
    return key !== lastEscapeFrom && key !== lastEscapeTo
  })
}

/**
 * Track escape for anti-ping-pong
 */
function trackEscape(player, action, now) {
  const currentKey = posKey(player.x, player.y)

  // Calculate target position
  const targetPos = getTargetPosition(player, action)
  const targetKey = posKey(targetPos.x, targetPos.y)

  lastEscapeFrom = currentKey
  lastEscapeTo = targetKey
  lastEscapeTime = now
}

/**
 * Track escape move for anti-ping-pong
 */
function trackEscapeMove(player, direction, now) {
  trackEscape(player, direction, now)
}

/**
 * Get target position after move
 */
function getTargetPosition(current, action) {
  const moves = {
    UP: { x: current.x, y: current.y - 1 },
    DOWN: { x: current.x, y: current.y + 1 },
    LEFT: { x: current.x - 1, y: current.y },
    RIGHT: { x: current.x + 1, y: current.y },
    STAY: { x: current.x, y: current.y },
  }
  return moves[action] || current
}

/**
 * Check if player is safe
 */
export function checkSafety(map, player, bombs, bombers, myBomber) {
  const safeTiles = findSafeTiles(map, bombs, bombers, myBomber)
  const unsafeTiles = findUnsafeTiles(map, bombs, bombers)

  const isPlayerSafe = bombs.length
    ? safeTiles.some((tile) => tile.x === player.x && tile.y === player.y)
    : true

  // Check for urgent threats
  const now = Date.now()
  const URGENCY_THRESHOLD = 3000

  let hasUrgentThreat = false
  const playerKey = posKey(player.x, player.y)

  if (unsafeTiles.has(playerKey)) {
    for (const bomb of bombs) {
      const timeRemaining = bomb.lifeTime - (now - (bomb.createdAt || now))
      if (timeRemaining > 0 && timeRemaining <= URGENCY_THRESHOLD) {
        hasUrgentThreat = true
        break
      }
    }
  }

  const finalStatus = isPlayerSafe && !hasUrgentThreat


  return { isPlayerSafe: finalStatus, safeTiles }
}

/**
 * Reset anti-ping-pong tracking (exported for testing)
 */
export function resetEscapeTracking() {
  lastEscapeFrom = null
  lastEscapeTo = null
  lastEscapeTime = 0
}
