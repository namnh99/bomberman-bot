import { ITEM_VALUES } from "../../utils/constants.js"
import { manhattanDistance } from "../../utils/gridUtils.js"

/**
 * Calculate dynamic priority for items based on current game state
 * Returns adjusted value considering bomber stats and context
 */
export function dynamicItemPriority(item, myBomber, enemies, myPos, gamePhase = "mid") {
  const baseValue = ITEM_VALUES[item.type] || 1
  let multiplier = 1.0

  // Distance penalty (closer items are more valuable)
  const distance = manhattanDistance(myPos.x, myPos.y, item.x, item.y)
  const distanceMultiplier = Math.max(0.5, 1 - distance * 0.05) // Max 50% penalty
  multiplier *= distanceMultiplier

  // Stat-based adjustments
  const currentRange = myBomber.explosionRange || 1
  const currentSpeed = myBomber.speed || 1
  const currentBombs = myBomber.bombCount || 1

  if (item.type === "R") {
    // Range item
    if (currentRange >= 5) {
      multiplier *= 0.6 // Already have good range
    } else if (currentRange <= 2) {
      multiplier *= 1.5 // Really need range
    }
  } else if (item.type === "S") {
    // Speed item
    if (currentSpeed >= 3) {
      multiplier *= 0.5 // Already fast enough
    } else if (currentSpeed <= 1) {
      multiplier *= 1.8 // Really need speed
    }
  } else if (item.type === "B") {
    // Bomb item
    if (currentBombs >= 4) {
      multiplier *= 0.7 // Have enough bombs
    } else if (currentBombs <= 1) {
      multiplier *= 1.6 // Need more bombs
    }
  }

  // Game phase adjustments
  if (gamePhase === "early") {
    // Early game: prioritize range and bombs for chest breaking
    if (item.type === "R") multiplier *= 1.3
    if (item.type === "B") multiplier *= 1.2
    if (item.type === "S") multiplier *= 0.9
  } else if (gamePhase === "late") {
    // Late game: prioritize speed for combat
    if (item.type === "S") multiplier *= 1.4
    if (item.type === "B") multiplier *= 1.3
    if (item.type === "R") multiplier *= 0.8
  }

  // Enemy proximity penalty (dangerous to collect)
  const nearestEnemy = findNearestEnemy(item, enemies)
  if (nearestEnemy && nearestEnemy.distance < 5) {
    const dangerPenalty = 1 - (5 - nearestEnemy.distance) * 0.15
    multiplier *= Math.max(0.4, dangerPenalty) // Max 60% penalty
  }

  return {
    item,
    baseValue,
    finalValue: baseValue * multiplier,
    multiplier,
    distance,
  }
}

/**
 * Find nearest enemy to a position
 */
function findNearestEnemy(pos, enemies) {
  if (!enemies || enemies.length === 0) return null

  let nearest = null
  let minDistance = Infinity

  for (const enemy of enemies) {
    const distance = manhattanDistance(pos.x, pos.y, enemy.x, enemy.y)
    if (distance < minDistance) {
      minDistance = distance
      nearest = { enemy, distance }
    }
  }

  return nearest
}

/**
 * Calculate risk tolerance based on game state
 * Returns aggression level (0.0 = defensive, 1.0 = aggressive)
 */
export function calculateRiskTolerance(myBomber, enemies, items, chests) {
  let aggression = 0.5 // Default: balanced

  // Bomb count factor
  const bombRatio = (myBomber.bombCount || 1) / 5
  aggression += bombRatio * 0.2 // More bombs = more aggressive

  // Range factor
  const rangeRatio = (myBomber.explosionRange || 1) / 5
  aggression += rangeRatio * 0.15 // More range = more aggressive

  // Speed factor
  const speedRatio = (myBomber.speed || 1) / 3
  aggression += speedRatio * 0.15 // More speed = more aggressive (can escape easily)

  // Enemy count factor
  const enemyCount = enemies.filter((e) => e.bomber && e.bomber.isAlive).length
  if (enemyCount === 0) {
    aggression += 0.2 // No enemies = focus on farming
  } else if (enemyCount >= 3) {
    aggression -= 0.15 // Many enemies = be cautious
  }

  // Resource availability
  const resourceCount = ((items && items.length) || 0) + ((chests && chests.length) || 0)
  if (resourceCount > 10) {
    aggression -= 0.1 // Many resources = farm safely
  } else if (resourceCount < 3) {
    aggression += 0.2 // Few resources = must compete aggressively
  }

  // Clamp between 0 and 1
  return Math.max(0.0, Math.min(1.0, aggression))
}

/**
 * Determine current game phase based on state
 */
export function determineGamePhase(myBomber, enemies, items, chests, elapsedTime) {
  const aliveEnemies = enemies.filter((e) => e.bomber && e.bomber.isAlive).length
  const totalResources = ((items && items.length) || 0) + ((chests && chests.length) || 0)

  // Time-based (if available)
  if (elapsedTime !== undefined) {
    if (elapsedTime < 60) return "early"
    if (elapsedTime > 180) return "late"
  }

  // Resource-based
  if (totalResources > 20) return "early"
  if (totalResources < 5) return "late"

  // Enemy-based
  if (aliveEnemies <= 1) return "late"
  if (aliveEnemies >= 3) return "early"

  // Stats-based
  const avgStat =
    ((myBomber.explosionRange || 1) + (myBomber.speed || 1) + (myBomber.bombCount || 1)) / 3
  if (avgStat < 1.5) return "early"
  if (avgStat > 3) return "late"

  return "mid"
}
