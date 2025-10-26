import { manhattanDistance } from "../../utils/gridUtils.js"

/**
 * Score enemy threat level
 * Returns threat score (0 = harmless, 1 = extreme threat)
 */
export function scoreEnemyThreat(enemy, myBomber, myPos) {
  const { x: ex, y: ey, bomber } = enemy

  if (!bomber || !bomber.isAlive) {
    return { threat: 0, reason: "dead" }
  }

  const distance = manhattanDistance(myPos.x, myPos.y, ex, ey)

  // Base threat from stats
  const bombPower = (bomber.bombCount || 1) * (bomber.explosionRange || 1)
  const myPower = (myBomber.bombCount || 1) * (myBomber.explosionRange || 1)

  const powerRatio = bombPower / Math.max(myPower, 1)

  // Distance factor (closer = more threatening)
  const distanceFactor = Math.max(0, 1 - distance / 15)

  // Speed comparison (faster enemy is more threatening)
  const enemySpeed = bomber.speed || 1
  const mySpeed = myBomber.speed || 1
  const speedThreat = enemySpeed > mySpeed ? 0.3 : 0

  // Calculate overall threat
  let threat = powerRatio * 0.5 + distanceFactor * 0.3 + speedThreat * 0.2

  // Cap at 1.0
  threat = Math.min(1.0, threat)

  // Determine threat level
  let level = "low"
  let shouldAvoid = false
  let shouldEngage = false

  if (threat >= 0.7) {
    level = "critical"
    shouldAvoid = true
  } else if (threat >= 0.5) {
    level = "high"
    shouldAvoid = distance < 5
  } else if (threat >= 0.3) {
    level = "medium"
    shouldEngage = powerRatio < 0.8 && distance < 6
  } else {
    level = "low"
    shouldEngage = powerRatio < 0.6
  }

  return {
    threat,
    level,
    distance,
    powerRatio,
    shouldAvoid,
    shouldEngage,
    stats: {
      bombs: bomber.bombCount || 1,
      range: bomber.explosionRange || 1,
      speed: bomber.speed || 1,
    },
  }
}

/**
 * Find most threatening enemy
 */
export function findMostThreateningEnemy(enemies, myBomber, myPos) {
  let maxThreat = 0
  let mostThreatening = null

  for (const enemy of enemies) {
    const threat = scoreEnemyThreat(enemy, myBomber, myPos)

    if (threat.threat > maxThreat) {
      maxThreat = threat.threat
      mostThreatening = { enemy, ...threat }
    }
  }

  return mostThreatening
}

/**
 * Evaluate if we should fight or flee
 */
export function shouldFightOrFlee(enemies, myBomber, myPos, resources) {

  if (enemies.length === 0) {
    return "neutral"
  }

  const mostThreatening = findMostThreateningEnemy(enemies, myBomber, myPos)

  if (!mostThreatening) {
    return "neutral"
  }

  const myPower = (myBomber.bombCount || 1) * (myBomber.explosionRange || 1) * (myBomber.speed || 1)
  const avgEnemyPower =
    enemies.reduce((sum, e) => {
      const b = e.bomber
      if (!b) return sum
      return sum + (b.bombCount || 1) * (b.explosionRange || 1) * (b.speed || 1)
    }, 0) / Math.max(enemies.length, 1)


  // CRITICAL: Check if we're in ENDGAME (few enemies, low resources)
  const isEndgame = enemies.length <= 3 && (resources.chestCount < 20 || resources.itemCount < 3)

  // ENDGAME: Ignore critical threats, fight aggressively!
  if (isEndgame && mostThreatening.level === "critical") {
    // Don't return "flee" - continue to endgame logic below
  } else if (mostThreatening.level === "critical") {
    // EARLY/MID GAME: Flee from critical threats
    return "flee"
  }

  // ENDGAME: Fight if few enemies left (1-3) - VERY aggressive!
  // REDUCED threshold to 50% - fight even when much weaker!
  if (enemies.length <= 3 && (resources.chestCount < 20 || resources.itemCount < 3)) {
    if (myPower >= avgEnemyPower * 0.5) {
      // Fight even if MUCH weaker - ultra aggressive endgame!
      return "fight"
    } else {
    }
  }

  // ULTRA AGGRESSIVE: Fight if we're stronger OR EQUAL
  // REDUCED to 1.0x - fight whenever not significantly weaker!
  if (myPower >= avgEnemyPower * 1.0 && (resources.itemCount > 5 || resources.chestCount > 3)) {
    return "fight"
  }

  // Fight if we're stronger and enemy is close
  if (myPower > avgEnemyPower && mostThreatening.distance < 5) {
    return "fight"
  }

  // VERY AGGRESSIVE: Fight if we have ≥60% power (was 75%)
  // This makes bot ULTRA willing to fight
  if (enemies.length >= 1 && myPower >= avgEnemyPower * 0.6) {
    return "fight"
  }

  // Only flee if outnumbered (3+) AND MUCH weaker (<50% power)
  // VERY AGGRESSIVE - only flee when truly hopeless!
  if (enemies.length >= 3 && myPower < avgEnemyPower * 0.5) {
    return "flee"
  }

  // Default: FIGHT unless extremely dangerous
  // ULTRA AGGRESSIVE - prefer fighting over fleeing
  if (mostThreatening.threat > 0.8) {
    return "flee"
  } else if (mostThreatening.threat < 0.5) {
    return "fight"
  }

  return "fight" // Changed from "neutral" to "fight" - always aggressive!
}
