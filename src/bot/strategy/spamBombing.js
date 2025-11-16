import { DIRS, WALKABLE } from "../../utils/constants.js"
import { manhattanDistance, isWalkable, posKey } from "../../utils/gridUtils.js"
import { getBombWithGrid } from "../../utils/bombUtils.js"
import { canPlaceBomb, getRemainingBombs } from "../../utils/bomberUtils.js"
import { willBombHitEnemy } from "./targetSelector.js"

/**
 * Spam Bombing Strategy: Place multiple bombs rapidly to trap enemy
 * Creates a "kill zone" where enemy cannot escape
 */

/**
 * Check if we can create a bomb trail to trap enemy
 * @returns {Object|null} Trail bombing plan with positions
 */
export function findTrailBombingPositions(player, enemy, map, bombs, myBomber) {
  const { x: px, y: py } = player
  const { x: ex, y: ey } = enemy
  const range = myBomber.explosionRange
  const remainingBombs = getRemainingBombs(myBomber, bombs, myBomber.uid)


  if (remainingBombs < 2) {
    return null
  }

  // Calculate direction from player to enemy
  const dx = ex - px
  const dy = ey - py

  // Determine primary direction (horizontal or vertical)
  const isHorizontal = Math.abs(dx) > Math.abs(dy)
  const moveDir = isHorizontal ? [Math.sign(dx), 0] : [0, Math.sign(dy)]

  const trailPositions = []
  let currentX = px
  let currentY = py

  // Plan bomb trail towards enemy (up to available bombs)
  const maxBombs = Math.min(remainingBombs, 3) // Max 3 bomb trail

  for (let i = 0; i < maxBombs; i++) {
    // Move one step in direction
    currentX += moveDir[0]
    currentY += moveDir[1]

    // Check if position is valid
    if (!isWalkable(currentX, currentY, map)) break

    // Check if bomb already exists
    const hasBomb = bombs.some((b) => {
      const { gridX, gridY } = getBombWithGrid(b)
      return gridX === currentX && gridY === currentY
    })

    if (hasBomb) break

    // Check if this position would hit enemy
    const wouldHit = willBombHitEnemy(currentX, currentY, ex, ey, map, range)

    trailPositions.push({
      x: currentX,
      y: currentY,
      step: i,
      wouldHit,
      distanceToEnemy: manhattanDistance(currentX, currentY, ex, ey),
    })

    // Stop if we would hit enemy (no need to go further)
    if (wouldHit) break
  }

  if (trailPositions.length < 2) {
    return null
  }


  return {
    positions: trailPositions,
    totalBombs: trailPositions.length,
    willHitEnemy: trailPositions.some((p) => p.wouldHit),
  }
}

/**
 * Check if we can create a cross pattern to trap enemy
 * @returns {Object|null} Cross bombing plan
 */
export function findCrossBombingPositions(player, enemy, map, bombs, myBomber) {
  const { x: ex, y: ey } = enemy
  const range = myBomber.explosionRange
  const remainingBombs = getRemainingBombs(myBomber, bombs, myBomber.uid)


  if (remainingBombs < 2) {
    return null
  }

  // SMART TRAP: Use bomb explosion zones to cover escape routes!
  // Enemy doesn't need to walk through bomb position - explosion zone is enough!
  const crossPositions = []
  let blockedRoutes = 0 // Count walls/bombs/zones blocking enemy

  for (const [dx, dy, dir] of DIRS) {
    let routeBlocked = false
    let bestPositionInDirection = null

    // Check if this escape route is already blocked by existing bombs
    for (let escapeStep = 1; escapeStep <= range; escapeStep++) {
      const escapeX = ex + dx * escapeStep
      const escapeY = ey + dy * escapeStep

      if (!isWalkable(escapeX, escapeY, map)) {
        blockedRoutes++ // Wall blocks
        routeBlocked = true
        break
      }

      // Check if enemy's escape path crosses existing bomb zone
      const crossesBombZone = bombs.some((b) => {
        const { gridX, gridY } = getBombWithGrid(b)
        const bombRange = b.explosionRange || range

        // Check if this escape position is in bomb's explosion zone
        if (gridX === escapeX && gridY === escapeY) return true

        // Check horizontal/vertical explosion lines
        if (gridX === escapeX && Math.abs(gridY - escapeY) <= bombRange) return true
        if (gridY === escapeY && Math.abs(gridX - escapeX) <= bombRange) return true

        return false
      })

      if (crossesBombZone) {
        blockedRoutes++ // Existing bomb zone blocks
        routeBlocked = true
        break
      }
    }

    if (routeBlocked) continue // This escape route already blocked

    // Find best bombing position to cover this escape route with explosion zone
    // We can bomb anywhere along the route as long as explosion reaches enemy
    for (let step = 1; step <= range; step++) {
      const bx = ex + dx * step
      const by = ey + dy * step

      if (!isWalkable(bx, by, map)) break

      // Check if bomb already exists at this position
      const hasBomb = bombs.some((b) => {
        const { gridX, gridY } = getBombWithGrid(b)
        return gridX === bx && gridY === by
      })

      if (hasBomb) {
        bestPositionInDirection = null // Can't use this position
        break
      }

      // Calculate how effective this position is for blocking escape
      // Closer to enemy = better coverage of escape route
      const distanceFromPlayer = manhattanDistance(player.x, player.y, bx, by)

      // BOMB ZONE TRAP: This bomb will cover tiles from [bx,by] up to range in all directions
      // The explosion zone will block enemy's escape through this route!
      const coverageScore = step // Closer to enemy = better coverage

      if (!bestPositionInDirection || coverageScore < bestPositionInDirection.coverageScore) {
        bestPositionInDirection = {
          x: bx,
          y: by,
          direction: dir,
          distanceFromPlayer,
          distanceToEnemy: step,
          coverageScore,
          bombingRange: step,
        }
      }
    }

    if (bestPositionInDirection) {
      crossPositions.push(bestPositionInDirection)
    }
  }

  // Calculate trap effectiveness:
  // If enemy already blocked by walls/bombs, we need fewer bombs to trap!
  // Example: Enemy at corner (2 walls) → only need 1 bomb to trap 3/4 routes
  const totalEscapeRoutes = 4
  const openRoutes = crossPositions.length
  const trapCoverage = blockedRoutes + Math.min(remainingBombs, openRoutes)


  // SMART: Accept trap if we can block >= 75% routes (3/4 or 4/4)
  // BOMB ZONE TRAP: Don't need exact positions - explosion zones will cover escape routes!
  if (trapCoverage < 3) {
    return null
  }

  if (crossPositions.length === 0) {
    return null
  }

  // SMART SORT: Prioritize positions with:
  // 1. Better coverage (closer to enemy = explosion zone covers more of escape route)
  // 2. Closer to player (faster to reach)
  crossPositions.sort((a, b) => {
    // Primary: Better coverage (closer to enemy)
    if (a.coverageScore !== b.coverageScore) {
      return a.coverageScore - b.coverageScore
    }
    // Secondary: Closer to player
    return a.distanceFromPlayer - b.distanceFromPlayer
  })

  // SMART: Take minimum bombs needed to reach 75-100% trap coverage
  // BOMB ZONE STRATEGY: Each bomb creates explosion zone covering entire escape route!
  const bombsNeeded = Math.min(
    Math.max(1, 3 - blockedRoutes), // Need enough to reach 3/4 coverage
    crossPositions.length,
    remainingBombs,
  )

  const selectedPositions = crossPositions.slice(0, bombsNeeded)


  return {
    positions: selectedPositions,
    totalBombs: selectedPositions.length,
    pattern: "CROSS",
  }
}

/**
 * Execute spam bombing strategy
 * @returns {Object|null} Bombing decision with sequence
 */
export function decideSpamBombing(player, enemy, map, bombs, bombers, myBomber, myUid) {

  const remainingBombs = getRemainingBombs(myBomber, bombs, myUid)
  const distance = manhattanDistance(player.x, player.y, enemy.x, enemy.y)
  const range = myBomber.explosionRange || 2


  // Need at least 2 bombs for spam strategy
  if (remainingBombs < 2) {
    return null
  }

  // Calculate distance thresholds based on explosion range
  // Range 1: Short distances (2-4 tiles for trail, 2-3 for cross, 1-2 for rapid)
  // Range 2 (DEFAULT): Medium distances (3-5 tiles for trail, 2-4 for cross, 1-3 for rapid)
  // Range 3+: Long distances (4-6 tiles for trail, 3-5 for cross, 1-4 for rapid)

  const trailMinDistance = range + 1 // Range 1→2, Range 2→3, Range 3→4
  const trailMaxDistance = range + 3 // Range 1→4, Range 2→5, Range 3→6

  const crossMinDistance = 2 // Always 2 (need some distance to cross-bomb)
  const crossMaxDistance = range + 2 // Range 1→3, Range 2→4, Range 3→5

  const rapidMinDistance = 1 // Always 1 to avoid distance=0 suicide
  const rapidMaxDistance = range + 1 // Range 1→2, Range 2→3, Range 3→4  // Strategy 1: Trail bombing (if enemy is far, create bomb trail)
  if (distance >= trailMinDistance && distance <= trailMaxDistance) {
    const trailPlan = findTrailBombingPositions(player, enemy, map, bombs, myBomber)

    if (trailPlan && trailPlan.willHitEnemy) {
      return {
        strategy: "TRAIL",
        positions: trailPlan.positions,
        firstPosition: trailPlan.positions[0],
        totalBombs: trailPlan.totalBombs,
      }
    }
  }

  // Strategy 2: Cross bombing (if enemy is close, surround them)
  if (distance >= crossMinDistance && distance <= crossMaxDistance) {
    const crossPlan = findCrossBombingPositions(player, enemy, map, bombs, myBomber)

    if (crossPlan) {
      return {
        strategy: "CROSS",
        positions: crossPlan.positions,
        firstPosition: crossPlan.positions[0],
        totalBombs: crossPlan.totalBombs,
      }
    }
  }

  // Strategy 3: Rapid spam (if very close, just spam bombs)
  // NOTE: distance must be >= 1 to avoid bombing self!
  if (distance >= rapidMinDistance && distance <= rapidMaxDistance && remainingBombs >= 2) {

    // Bomb current position and prepare to spam more
    return {
      strategy: "RAPID",
      positions: [player],
      firstPosition: player,
      totalBombs: remainingBombs, // Use all available
    }
  }

  // If distance = 0 (same position), this is a special case - should escape first!
  if (distance === 0) {
  }

  return null
}

/**
 * Check if we should continue spam bombing sequence
 * @returns {boolean} True if should place another bomb
 */
export function shouldContinueSpamming(player, enemy, bombs, myBomber, myUid, lastBombTime) {
  const remainingBombs = getRemainingBombs(myBomber, bombs, myUid)

  if (remainingBombs === 0) {
    return false
  }

  // Check time since last bomb (wait at least 500ms between bombs)
  const now = Date.now()
  const timeSinceLastBomb = lastBombTime ? now - lastBombTime : Infinity

  if (timeSinceLastBomb < 500) {
    return false
  }

  // Check if enemy is still in range
  const distance = manhattanDistance(player.x, player.y, enemy.x, enemy.y)

  if (distance > 6) {
    return false
  }

  return true
}
