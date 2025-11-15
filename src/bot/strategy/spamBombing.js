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

  console.log(`   🔥 Trail Bombing Analysis: ${remainingBombs} bombs available`)

  if (remainingBombs < 2) {
    console.log(`      ❌ Need at least 2 bombs for trail bombing`)
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
    console.log(`      ❌ Trail too short (${trailPositions.length} positions)`)
    return null
  }

  console.log(`      ✅ Trail bombing viable: ${trailPositions.length} bomb positions`)
  console.log(`         Positions: ${trailPositions.map((p) => `[${p.x},${p.y}]`).join(" → ")}`)

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

  console.log(`   ➕ Cross Bombing Analysis: ${remainingBombs} bombs available`)

  if (remainingBombs < 2) {
    console.log(`      ❌ Need at least 2 bombs for cross bombing`)
    return null
  }

  // Check 4 cardinal positions around enemy
  const crossPositions = []

  for (const [dx, dy, dir] of DIRS) {
    const bx = ex + dx
    const by = ey + dy

    if (!isWalkable(bx, by, map)) continue

    // Check if bomb already exists
    const hasBomb = bombs.some((b) => {
      const { gridX, gridY } = getBombWithGrid(b)
      return gridX === bx && gridY === by
    })

    if (hasBomb) continue

    // Check if reachable from player position
    const distanceFromPlayer = manhattanDistance(player.x, player.y, bx, by)

    crossPositions.push({
      x: bx,
      y: by,
      direction: dir,
      distanceFromPlayer,
      distanceToEnemy: 1, // Adjacent to enemy
    })
  }

  if (crossPositions.length < 2) {
    console.log(`      ❌ Not enough cross positions (${crossPositions.length} available)`)
    return null
  }

  // Sort by distance from player (closest first)
  crossPositions.sort((a, b) => a.distanceFromPlayer - b.distanceFromPlayer)

  // Take up to 2 closest positions
  const selectedPositions = crossPositions.slice(0, Math.min(2, remainingBombs))

  console.log(`      ✅ Cross bombing viable: ${selectedPositions.length} positions`)
  console.log(`         Positions: ${selectedPositions.map((p) => `[${p.x},${p.y}]`).join(" + ")}`)

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
  console.log(`\n💣 SPAM BOMBING ANALYSIS`)
  console.log(`   Player: [${player.x},${player.y}] | Enemy: [${enemy.x},${enemy.y}]`)

  const remainingBombs = getRemainingBombs(myBomber, bombs, myUid)
  const distance = manhattanDistance(player.x, player.y, enemy.x, enemy.y)
  const range = myBomber.explosionRange || 2

  console.log(`   Remaining bombs: ${remainingBombs} | Distance: ${distance} | Range: ${range}`)

  // Need at least 2 bombs for spam strategy
  if (remainingBombs < 2) {
    console.log(`   ❌ Not enough bombs for spam (need 2+, have ${remainingBombs})`)
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
      console.log(
        `   ✅ TRAIL BOMBING selected (${trailPlan.totalBombs} bombs, range ${range}, distance ${distance})`,
      )
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
      console.log(
        `   ✅ CROSS BOMBING selected (${crossPlan.totalBombs} bombs, range ${range}, distance ${distance})`,
      )
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
    console.log(
      `   ✅ RAPID SPAM selected (enemy very close, range ${range}, distance: ${distance})`,
    )

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
    console.log(`   ⚠️ Distance = 0 (same position as enemy) - cannot spam bomb here!`)
    console.log(`      Bot needs to move away before bombing`)
  }

  console.log(`   ❌ No viable spam bombing strategy`)
  return null
}

/**
 * Check if we should continue spam bombing sequence
 * @returns {boolean} True if should place another bomb
 */
export function shouldContinueSpamming(player, enemy, bombs, myBomber, myUid, lastBombTime) {
  const remainingBombs = getRemainingBombs(myBomber, bombs, myUid)

  if (remainingBombs === 0) {
    console.log(`   ⏸️  Spam sequence complete (no bombs left)`)
    return false
  }

  // Check time since last bomb (wait at least 500ms between bombs)
  const now = Date.now()
  const timeSinceLastBomb = lastBombTime ? now - lastBombTime : Infinity

  if (timeSinceLastBomb < 500) {
    console.log(`   ⏸️  Waiting for spam cooldown (${timeSinceLastBomb}ms / 500ms)`)
    return false
  }

  // Check if enemy is still in range
  const distance = manhattanDistance(player.x, player.y, enemy.x, enemy.y)

  if (distance > 6) {
    console.log(`   ⏸️  Enemy too far (${distance} > 6), stopping spam`)
    return false
  }

  console.log(`   💣 Continue spamming (${remainingBombs} bombs left, enemy at ${distance} tiles)`)
  return true
}
