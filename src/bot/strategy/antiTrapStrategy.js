import { DIRS, WALKABLE } from "../../utils/constants.js"
import { inBounds, posKey } from "../../utils/gridUtils.js"
import { findUnsafeTiles, createBombTileMap } from "../pathfinding/dangerMap.js"
import { getBombWithGrid, getTimeUntilExplosion } from "../../utils/bombUtils.js"

/**
 * Detect if bot is being trapped by enemy bombs
 * Returns true if bot is in a position with limited escape routes
 *
 * @param {Object} myPos - Current position {x, y}
 * @param {Array} map - Game map
 * @param {Array} bombs - All active bombs
 * @param {Array} bombers - All bombers
 * @param {string} myUid - Player UID
 * @returns {Object} { isTrapped: boolean, severity: number, escapeRoutes: number }
 */
export function detectTrapSituation(myPos, map, bombs, bombers, myUid) {
  const myBomber = bombers.find((b) => b.uid === myUid)
  const unsafeTiles = findUnsafeTiles(map, bombs, bombers)
  const bombTiles = createBombTileMap(bombs)

  // Count available escape routes (walkable tiles not in blast zones)
  let walkableNeighbors = 0
  let safeNeighbors = 0
  let blockedByBombs = 0
  let blockedByWalls = 0
  let inBlastZone = 0

  const neighbors = []

  for (const [dx, dy, dir] of DIRS) {
    const nx = myPos.x + dx
    const ny = myPos.y + dy
    const key = posKey(nx, ny)

    if (!inBounds(nx, ny)) {
      blockedByWalls++
      continue
    }

    const cell = map[ny][nx]
    const hasBomb = bombTiles.has(key)
    const isUnsafe = unsafeTiles.has(key)
    const isWalk = WALKABLE.includes(cell)

    neighbors.push({
      direction: dir,
      x: nx,
      y: ny,
      walkable: isWalk,
      hasBomb,
      isUnsafe,
    })

    if (hasBomb) {
      blockedByBombs++
    } else if (!isWalk) {
      blockedByWalls++
    } else {
      walkableNeighbors++
      if (!isUnsafe) {
        safeNeighbors++
      } else {
        inBlastZone++
      }
    }
  }

  // Calculate trap severity
  // 0 = not trapped (3-4 walkable neighbors)
  // 1-2 = partial trap (1-2 walkable neighbors)
  // 3-4 = severe trap (0-1 safe neighbors)
  const isTrapped = walkableNeighbors <= 2 || safeNeighbors === 0

  let severity = 0
  if (safeNeighbors === 0 && walkableNeighbors === 0) {
    severity = 4 // CRITICAL: Completely boxed in
  } else if (safeNeighbors === 0) {
    severity = 3 // SEVERE: Can move but all tiles unsafe
  } else if (walkableNeighbors === 1) {
    severity = 2 // HIGH: Only one exit
  } else if (walkableNeighbors === 2) {
    severity = 1 // MEDIUM: Limited options
  }

  // Check if bombs are from enemies (trap attempt)
  const enemyBombs = bombs.filter((b) => b.uid !== myUid)
  const nearbyEnemyBombs = enemyBombs.filter((b) => {
    const dist = Math.abs(b.x / 40 - myPos.x) + Math.abs(b.y / 40 - myPos.y)
    return dist <= 3
  })

  const isEnemyTrap = nearbyEnemyBombs.length >= 2

  return {
    isTrapped,
    severity,
    escapeRoutes: walkableNeighbors,
    safeRoutes: safeNeighbors,
    blockedByBombs,
    blockedByWalls,
    inBlastZone,
    isEnemyTrap,
    neighbors,
    analysis: getTrapAnalysis(severity, isEnemyTrap, nearbyEnemyBombs.length),
  }
}

/**
 * Get human-readable analysis of trap situation
 */
function getTrapAnalysis(severity, isEnemyTrap, enemyBombCount) {
  if (severity === 0) {
    return "Safe - multiple escape routes available"
  }

  const trapType = isEnemyTrap ? "Enemy trap" : "Self-inflicted"

  switch (severity) {
    case 1:
      return `${trapType} - Limited mobility (2 exits)`
    case 2:
      return `${trapType} - High risk (1 exit only)`
    case 3:
      return `${trapType} - SEVERE (no safe exits, ${enemyBombCount} enemy bombs)`
    case 4:
      return `${trapType} - CRITICAL (completely boxed in)`
    default:
      return "Unknown"
  }
}

/**
 * Suggest evasive action when trapped
 */
export function suggestEvasiveAction(trapInfo, myPos, map, bombs, bombers, myUid) {
  if (!trapInfo.isTrapped) {
    return null
  }

  const myBomber = bombers.find((b) => b.uid === myUid)
  const unsafeTiles = findUnsafeTiles(map, bombs, bombers)

  // Find the "least bad" direction
  const scoredDirections = trapInfo.neighbors
    .filter((n) => n.walkable && !n.hasBomb)
    .map((n) => {
      const key = posKey(n.x, n.y)
      const isUnsafe = unsafeTiles.has(key)

      // Calculate time margin (how long until bombs explode)
      let minTimeMargin = Infinity
      for (const bomb of bombs) {
        const { gridX, gridY } = getBombWithGrid(bomb)
        const dist = Math.abs(gridX - n.x) + Math.abs(gridY - n.y)

        if (dist <= bomb.explosionRange) {
          const timeRemaining = getTimeUntilExplosion(bomb)
          minTimeMargin = Math.min(minTimeMargin, timeRemaining)
        }
      }

      // Score: prefer directions with more time
      const score = minTimeMargin === Infinity ? 10000 : minTimeMargin

      return {
        direction: n.direction,
        x: n.x,
        y: n.y,
        isUnsafe,
        timeMargin: minTimeMargin,
        score,
      }
    })

  if (scoredDirections.length === 0) {
    return {
      action: "STAY",
      reason: "No walkable directions - completely trapped",
      isFatal: true,
    }
  }

  // Sort by score (highest = most time)
  scoredDirections.sort((a, b) => b.score - a.score)

  const best = scoredDirections[0]

  return {
    action: best.direction,
    reason: `Evasive move towards bomb with most time (${(best.timeMargin / 1000).toFixed(1)}s)`,
    isFatal: best.timeMargin < 1000, // Less than 1s = likely death
    timeMargin: best.timeMargin,
    destination: { x: best.x, y: best.y },
  }
}
