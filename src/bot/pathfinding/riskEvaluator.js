import { DIRS } from "../../utils/constants.js"
import { isWalkable, posKey, manhattanDistance } from "../../utils/gridUtils.js"

/**
 * Detect if a position is a dangerous corner or dead-end
 * Returns risk score (0 = safe, 1 = extreme danger)
 */
export function evaluatePositionRisk(x, y, map, bombs, enemies) {
  let riskScore = 0

  // 1. Check escape route count
  const escapeRoutes = countEscapeRoutes(x, y, map)

  if (escapeRoutes === 0) {
    riskScore += 1.0 // Trapped!
  } else if (escapeRoutes === 1) {
    riskScore += 0.7 // Dead-end
  } else if (escapeRoutes === 2) {
    riskScore += 0.3 // Corner
  }

  // 2. Check nearby bombs
  const nearestBomb = findNearestBomb(x, y, bombs)
  if (nearestBomb) {
    const bombDistance = nearestBomb.distance
    if (bombDistance <= 2) {
      riskScore += 0.4
    } else if (bombDistance <= 4) {
      riskScore += 0.2
    }
  }

  // 3. Check nearby enemies
  const nearestEnemy = findNearestEnemy(x, y, enemies)
  if (nearestEnemy) {
    const enemyDistance = nearestEnemy.distance
    if (enemyDistance <= 3) {
      riskScore += 0.3
    } else if (enemyDistance <= 5) {
      riskScore += 0.1
    }
  }

  // 4. Check if position is surrounded by destructible walls
  const wallCount = countAdjacentWalls(x, y, map)
  riskScore += wallCount * 0.05

  return Math.min(1.0, riskScore)
}

/**
 * Count available escape routes from a position
 */
function countEscapeRoutes(x, y, map, depth = 3) {
  const routes = []
  const visited = new Set([posKey(x, y)])

  for (const [dx, dy, dir] of DIRS) {
    const nx = x + dx
    const ny = y + dy

    if (!isWalkable(nx, ny, map)) continue

    // BFS to see if this direction leads to open space
    const hasEscape = exploreDirection(nx, ny, map, depth, visited)
    if (hasEscape) {
      routes.push(dir)
    }
  }

  return routes.length
}

/**
 * Explore direction to check if it leads to open space
 */
function exploreDirection(startX, startY, map, maxDepth, globalVisited) {
  const queue = [{ x: startX, y: startY, depth: 0 }]
  const localVisited = new Set([posKey(startX, startY)])
  let openSpaceCount = 0

  while (queue.length > 0) {
    const { x, y, depth } = queue.shift()

    if (depth >= maxDepth) {
      openSpaceCount++
      continue
    }

    for (const [dx, dy] of DIRS) {
      const nx = x + dx
      const ny = y + dy
      const key = posKey(nx, ny)

      if (localVisited.has(key) || globalVisited.has(key)) continue
      if (!isWalkable(nx, ny, map)) continue

      localVisited.add(key)
      queue.push({ x: nx, y: ny, depth: depth + 1 })
    }
  }

  return openSpaceCount >= 3 // Needs at least 3 reachable tiles to be "open"
}

/**
 * Find nearest bomb to position
 */
function findNearestBomb(x, y, bombs) {
  if (!bombs || bombs.length === 0) return null

  let nearest = null
  let minDistance = Infinity

  for (const bomb of bombs) {
    if (bomb.isExploded) continue

    const bx = Math.floor(bomb.x / 40)
    const by = Math.floor(bomb.y / 40)
    const distance = manhattanDistance(x, y, bx, by)

    if (distance < minDistance) {
      minDistance = distance
      nearest = { bomb, distance }
    }
  }

  return nearest
}

/**
 * Find nearest enemy to position
 */
function findNearestEnemy(x, y, enemies) {
  if (!enemies || enemies.length === 0) return null

  let nearest = null
  let minDistance = Infinity

  for (const enemy of enemies) {
    const distance = manhattanDistance(x, y, enemy.x, enemy.y)

    if (distance < minDistance) {
      minDistance = distance
      nearest = { enemy, distance }
    }
  }

  return nearest
}

/**
 * Count adjacent walls (destructible or indestructible)
 */
function countAdjacentWalls(x, y, map) {
  let count = 0

  for (const [dx, dy] of DIRS) {
    const nx = x + dx
    const ny = y + dy

    if (map[ny] && ["W", "C"].includes(map[ny][nx])) {
      count++
    }
  }

  return count
}

/**
 * Find safest position within radius
 */
export function findSafestNearbyPosition(currentPos, map, bombs, enemies, radius = 3) {
  const candidates = []

  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const x = currentPos.x + dx
      const y = currentPos.y + dy

      if (!isWalkable(x, y, map)) continue

      const risk = evaluatePositionRisk(x, y, map, bombs, enemies)
      const distance = Math.abs(dx) + Math.abs(dy)

      candidates.push({
        x,
        y,
        risk,
        distance,
        score: risk * 10 + distance * 0.5, // Heavily weight risk over distance
      })
    }
  }

  if (candidates.length === 0) return null

  candidates.sort((a, b) => a.score - b.score)
  return candidates[0]
}

/**
 * Check if moving to position would trap us
 */
export function wouldMoveTrapUs(currentPos, nextPos, map, bombs, enemies) {
  const currentRisk = evaluatePositionRisk(currentPos.x, currentPos.y, map, bombs, enemies)
  const nextRisk = evaluatePositionRisk(nextPos.x, nextPos.y, map, bombs, enemies)

  // Don't move if next position is significantly riskier
  return nextRisk > currentRisk + 0.3
}
