import { DIRS, WALKABLE } from "../../utils/constants.js"
import { createFutureBomb, getBombWithGrid } from "../../utils/bombUtils.js"
import { willBombHitEnemy } from "./targetSelector.js"
import { manhattanDistance, posKey, isWalkable } from "../../utils/gridUtils.js"
import { findSafeTiles, findBestPath } from "../pathfinding/index.js"
import { predictEnemyPositions } from "./enemyPredictor.js"
import { decideSpamBombing } from "./spamBombing.js"

/**
 * Advanced combat strategy: Predictive bombing to kill enemies
 * Instead of waiting to be adjacent, predict enemy movement and bomb their escape routes
 */

/**
 * Find enemy's possible escape routes and identify choke points
 * @returns {Array} Array of choke point positions with score
 */
function findEnemyEscapeRoutes(enemy, map, bombs, range = 3) {
  const escapeRoutes = []
  const { x: ex, y: ey } = enemy

  // BFS to find all tiles enemy can reach within N steps
  const queue = [{ x: ex, y: ey, steps: 0, path: [] }]
  const visited = new Set([posKey(ex, ey)])

  while (queue.length > 0) {
    const { x, y, steps, path } = queue.shift()

    if (steps >= range) {
      // This is an escape destination
      escapeRoutes.push({
        x,
        y,
        steps,
        path,
        priority: range - steps, // Closer = higher priority
      })
      continue
    }

    for (const [dx, dy, dir] of DIRS) {
      const nx = x + dx
      const ny = y + dy
      const key = posKey(nx, ny)

      if (visited.has(key)) continue
      if (!isWalkable(nx, ny, map)) continue

      // Check if there's a bomb blocking this route
      const hasBomb = bombs.some((b) => {
        const { gridX, gridY } = getBombWithGrid(b)
        return gridX === nx && gridY === ny
      })

      if (hasBomb) continue

      visited.add(key)
      queue.push({
        x: nx,
        y: ny,
        steps: steps + 1,
        path: [...path, dir],
      })
    }
  }

  return escapeRoutes
}

/**
 * Find optimal bombing position to block enemy escape routes
 * Strategy: Bomb positions that cut off multiple escape paths
 */
export function findBlockingBombPosition(
  enemy,
  player,
  map,
  bombs,
  bombers,
  myBomber,
  explosionRange,
) {

  // Get enemy's possible escape routes
  const escapeRoutes = findEnemyEscapeRoutes(enemy, map, bombs, 4)

  if (escapeRoutes.length === 0) {
    return null
  }

  // Find positions where bombing would block the most escape routes
  const blockingPositions = []

  // Check positions within bombing range of enemy
  for (let dx = -explosionRange; dx <= explosionRange; dx++) {
    for (let dy = -explosionRange; dy <= explosionRange; dy++) {
      // Only check cross pattern (bomb explosion pattern)
      if (dx !== 0 && dy !== 0) continue

      const bx = enemy.x + dx
      const by = enemy.y + dy

      if (!isWalkable(bx, by, map)) continue

      // Check if there's already a bomb here
      const hasBomb = bombs.some((b) => {
        const { gridX, gridY } = getBombWithGrid(b)
        return gridX === bx && gridY === by
      })

      if (hasBomb) continue

      // Count how many escape routes this bomb would block
      let blockedRoutes = 0
      let hitEnemy = false

      // Check if bomb hits enemy directly
      if (willBombHitEnemy(bx, by, enemy.x, enemy.y, map, explosionRange)) {
        hitEnemy = true
        blockedRoutes += 10 // High priority if hitting enemy directly
      }

      // Check how many escape routes pass through bomb blast zone
      for (const route of escapeRoutes) {
        const routeBlocked = route.path.some((dir, idx) => {
          let rx = enemy.x
          let ry = enemy.y

          // Simulate path
          for (let i = 0; i <= idx; i++) {
            const d = route.path[i]
            if (d === "UP") ry--
            else if (d === "DOWN") ry++
            else if (d === "LEFT") rx--
            else if (d === "RIGHT") rx++
          }

          // Check if this position is in bomb blast zone
          return willBombHitEnemy(bx, by, rx, ry, map, explosionRange)
        })

        if (routeBlocked) blockedRoutes++
      }

      if (blockedRoutes > 0) {
        const distanceFromPlayer = manhattanDistance(player.x, player.y, bx, by)
        const distanceFromEnemy = manhattanDistance(enemy.x, enemy.y, bx, by)

        blockingPositions.push({
          x: bx,
          y: by,
          blockedRoutes,
          hitEnemy,
          distanceFromPlayer,
          distanceFromEnemy,
          score: blockedRoutes * 10 - distanceFromPlayer + (hitEnemy ? 50 : 0),
        })
      }
    }
  }

  if (blockingPositions.length === 0) {
    return null
  }

  // Sort by score (best blocking positions first)
  blockingPositions.sort((a, b) => b.score - a.score)

  const best = blockingPositions[0]

  return best
}

/**
 * Check if enemy is in a vulnerable position (corner, dead end, etc.)
 */
export function isEnemyVulnerable(enemy, map, bombs) {
  const { x, y } = enemy

  // Count walkable adjacent tiles (escape options)
  let escapeOptions = 0
  for (const [dx, dy] of DIRS) {
    const nx = x + dx
    const ny = y + dy

    if (!isWalkable(nx, ny, map)) continue

    // Check if there's a bomb blocking
    const hasBomb = bombs.some((b) => {
      const { gridX, gridY } = getBombWithGrid(b)
      return gridX === nx && gridY === ny
    })

    if (!hasBomb) escapeOptions++
  }

  // Vulnerable if 2 or fewer escape options (corner/deadend)
  return escapeOptions <= 2
}

/**
 * Advanced predictive bombing: Bomb where enemy WILL BE, not where they ARE
 */
export function findPredictiveBombPosition(
  enemy,
  player,
  map,
  bombs,
  bombers,
  myBomber,
  explosionRange,
) {

  // Predict enemy positions for next 3 ticks
  const predictions = predictEnemyPositions([enemy], map, bombs, 3)

  if (predictions.length === 0 || predictions[0].predictedPositions.length === 0) {
    return null
  }

  const prediction = predictions[0]
  const highProbPositions = prediction.predictedPositions.filter((p) => p.probability > 0.15)


  // Find positions where we can bomb to hit predicted enemy location
  const bombPositions = []

  for (const predictedPos of highProbPositions) {
    // Check positions around predicted location where we could place bomb
    for (let dx = -explosionRange; dx <= explosionRange; dx++) {
      for (let dy = -explosionRange; dy <= explosionRange; dy++) {
        if (dx !== 0 && dy !== 0) continue // Cross pattern only

        const bx = predictedPos.x + dx
        const by = predictedPos.y + dy

        if (!isWalkable(bx, by, map)) continue

        // Check if bomb already exists
        const hasBomb = bombs.some((b) => {
          const { gridX, gridY } = getBombWithGrid(b)
          return gridX === bx && gridY === by
        })

        if (hasBomb) continue

        // Check if this position would hit predicted enemy location
        if (willBombHitEnemy(bx, by, predictedPos.x, predictedPos.y, map, explosionRange)) {
          const distanceFromPlayer = manhattanDistance(player.x, player.y, bx, by)

          bombPositions.push({
            x: bx,
            y: by,
            predictedSteps: predictedPos.steps,
            probability: predictedPos.probability,
            distanceFromPlayer,
            score: predictedPos.probability * 100 - distanceFromPlayer - predictedPos.steps * 5,
          })
        }
      }
    }
  }

  if (bombPositions.length === 0) {
    return null
  }

  // Sort by score
  bombPositions.sort((a, b) => b.score - a.score)

  const best = bombPositions[0]

  return best
}

/**
 * Main advanced combat decision
 * Combines blocking, predictive, and range bombing strategies
 */
export function decideAdvancedCombat(enemy, player, map, bombs, bombers, myBomber, myUid) {
  const distance = manhattanDistance(enemy.x, enemy.y, player.x, player.y)
  const explosionRange = myBomber.explosionRange


  // PRIORITY: Check spam bombing (if have 2+ bombs, try to spam)
  const spamPlan = decideSpamBombing(player, enemy, map, bombs, bombers, myBomber, myUid)

  if (spamPlan) {
    // Return spam plan to be executed
    return {
      position: spamPlan.firstPosition,
      strategy: `SPAM_${spamPlan.strategy}`,
      spamPlan, // Include full spam plan
      escapePath: null, // Will calculate after bombing
      escapeCoordinates: [],
      distance: manhattanDistance(
        player.x,
        player.y,
        spamPlan.firstPosition.x,
        spamPlan.firstPosition.y,
      ),
    }
  }

  // Strategy 1: Check if enemy is vulnerable (corner/trapped)
  const vulnerable = isEnemyVulnerable(enemy, map, bombs)
  if (vulnerable) {
  }

  // Strategy 2: Find blocking positions (cut off escape routes)
  const blockingPos = findBlockingBombPosition(
    enemy,
    player,
    map,
    bombs,
    bombers,
    myBomber,
    explosionRange,
  )

  // Strategy 3: Find predictive positions (bomb where enemy will be)
  const predictivePos = findPredictiveBombPosition(
    enemy,
    player,
    map,
    bombs,
    bombers,
    myBomber,
    explosionRange,
  )

  // Choose best strategy
  let chosenPosition = null
  let strategy = null

  if (vulnerable && blockingPos && blockingPos.distanceFromPlayer <= 2) {
    // Vulnerable enemy + close blocking position = PRIORITY
    chosenPosition = blockingPos
    strategy = "VULNERABLE_TRAP"
  } else if (blockingPos && blockingPos.hitEnemy && blockingPos.distanceFromPlayer <= 3) {
    // Direct hit + close = HIGH PRIORITY
    chosenPosition = blockingPos
    strategy = "DIRECT_HIT"
  } else if (blockingPos && blockingPos.blockedRoutes >= 3) {
    // Blocks many routes = GOOD TRAP
    chosenPosition = blockingPos
    strategy = "ESCAPE_BLOCKING"
  } else if (predictivePos && predictivePos.probability > 0.3) {
    // High probability prediction
    chosenPosition = predictivePos
    strategy = "PREDICTIVE"
  } else if (distance <= explosionRange + 1) {
    // Enemy within range - try range bombing
    strategy = "RANGE_BOMB"

    // Find position between player and enemy
    const dx = Math.sign(enemy.x - player.x)
    const dy = Math.sign(enemy.y - player.y)

    if (dx !== 0 && dy === 0) {
      // Horizontal alignment
      chosenPosition = { x: player.x + dx, y: player.y }
    } else if (dy !== 0 && dx === 0) {
      // Vertical alignment
      chosenPosition = { x: player.x, y: player.y + dy }
    } else {
      // Diagonal - choose based on better alignment
      const horizontalAlign = Math.abs(player.x - enemy.x)
      const verticalAlign = Math.abs(player.y - enemy.y)

      if (horizontalAlign < verticalAlign) {
        chosenPosition = { x: player.x, y: player.y + dy }
      } else {
        chosenPosition = { x: player.x + dx, y: player.y }
      }
    }
  }

  if (!chosenPosition) {
    return null
  }

  // Validate chosen position
  if (!isWalkable(chosenPosition.x, chosenPosition.y, map)) {
    return null
  }

  // Check if we can escape after bombing
  const futureBombs = [
    ...bombs,
    createFutureBomb(chosenPosition.x, chosenPosition.y, explosionRange, myBomber.uid),
  ]

  const futureSafeTiles = findSafeTiles(map, futureBombs, bombers, myBomber)
  if (futureSafeTiles.length === 0) {
    return null
  }

  const escapePath = findBestPath(
    map,
    chosenPosition,
    futureSafeTiles,
    futureBombs,
    bombers,
    myUid,
    true,
  )

  if (!escapePath || escapePath.path.length === 0) {
    return null
  }


  return {
    position: chosenPosition,
    strategy,
    escapePath: escapePath.path,
    escapeCoordinates: escapePath.fullPathCoordinates || [],
    distance: manhattanDistance(player.x, player.y, chosenPosition.x, chosenPosition.y),
  }
}
