import { DIRS } from "../../utils/constants.js"
import { isWalkable, manhattanDistance, canExplosionReach } from "../../utils/gridUtils.js"

/**
 * Find opportunities to trap enemies with bombs
 * Returns positions where bombing would block enemy escape routes
 */
export function findTrapOpportunities(enemies, map, myBomber, myPos) {
  const trapOpportunities = []

  for (const enemy of enemies) {
    const { x: ex, y: ey, bomber } = enemy

    // Find all escape routes for this enemy
    const escapeRoutes = findEscapeRoutes(ex, ey, map)

    // Calculate trap value
    const trapValue = evaluateTrapPosition(myPos, enemy, escapeRoutes, map, myBomber)

    if (trapValue.canTrap) {
      trapOpportunities.push({
        enemy,
        trapValue: trapValue.score,
        escapeRoutes: escapeRoutes.length,
        bombPosition: trapValue.bombPosition,
        willKill: trapValue.willKill,
      })
    }
  }

  // Sort by trap value (highest first)
  trapOpportunities.sort((a, b) => b.trapValue - a.trapValue)

  return trapOpportunities
}

/**
 * Find all possible escape routes for an enemy at position (ex, ey)
 */
function findEscapeRoutes(ex, ey, map) {
  const routes = []
  const visited = new Set()
  const queue = [{ x: ex, y: ey, depth: 0 }]

  visited.add(`${ex},${ey}`)

  while (queue.length > 0) {
    const { x, y, depth } = queue.shift()

    // Only look 3 tiles away (escape range)
    if (depth >= 3) {
      routes.push({ x, y, depth })
      continue
    }

    for (const [dx, dy] of DIRS) {
      const nx = x + dx
      const ny = y + dy
      const key = `${nx},${ny}`

      if (!isWalkable(nx, ny, map)) continue
      if (visited.has(key)) continue

      visited.add(key)
      queue.push({ x: nx, y: ny, depth: depth + 1 })
    }
  }

  return routes
}

/**
 * Evaluate if we can trap enemy from current position
 */
function evaluateTrapPosition(myPos, enemy, escapeRoutes, map, myBomber) {
  const { x: ex, y: ey, bomber } = enemy
  const range = myBomber.explosionRange || 1

  // Check if we can place bomb adjacent to enemy
  const adjacentPositions = []
  for (const [dx, dy] of DIRS) {
    const bombX = ex + dx
    const bombY = ey + dy

    if (!isWalkable(bombX, bombY, map)) continue

    const distanceFromMe = manhattanDistance(myPos.x, myPos.y, bombX, bombY)

    adjacentPositions.push({
      x: bombX,
      y: bombY,
      distance: distanceFromMe,
    })
  }

  if (adjacentPositions.length === 0) {
    return { canTrap: false, score: 0 }
  }

  // Find best bomb position
  let bestPosition = null
  let maxBlockedRoutes = 0

  for (const pos of adjacentPositions) {
    const blockedRoutes = escapeRoutes.filter((route) => {
      // Check if explosion would reach this escape route
      return canExplosionReach(pos.x, pos.y, route.x, route.y, map, range)
    })

    if (blockedRoutes.length > maxBlockedRoutes) {
      maxBlockedRoutes = blockedRoutes.length
      bestPosition = pos
    }
  }

  if (!bestPosition) {
    return { canTrap: false, score: 0 }
  }

  // Calculate trap score
  const blockedPercentage = maxBlockedRoutes / Math.max(escapeRoutes.length, 1)
  const willKill = blockedPercentage >= 0.8 // 80%+ escape routes blocked
  const distancePenalty = bestPosition.distance / 10

  const score = blockedPercentage * 100 - distancePenalty + (willKill ? 50 : 0)

  return {
    canTrap: blockedPercentage >= 0.5, // At least 50% routes blocked
    score,
    bombPosition: bestPosition,
    blockedRoutes: maxBlockedRoutes,
    totalRoutes: escapeRoutes.length,
    willKill,
  }
}

/**
 * Check if enemy is in a confined space (corner, dead-end, narrow corridor)
 * INTERNAL HELPER - Not exported
 */
export function isEnemyTrapped(ex, ey, map) {
  let walkableNeighbors = 0

  for (const [dx, dy] of DIRS) {
    if (isWalkable(ex + dx, ey + dy, map)) {
      walkableNeighbors++
    }
  }

  // Corner: 2 or fewer exits
  // Dead-end: 1 exit
  return {
    isInCorner: walkableNeighbors <= 2,
    isInDeadEnd: walkableNeighbors === 1,
    exitCount: walkableNeighbors,
  }
}
