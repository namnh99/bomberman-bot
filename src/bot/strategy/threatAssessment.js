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
  console.log(`\n🔍 shouldFightOrFlee() called - enemies: ${enemies.length}`)

  if (enemies.length === 0) {
    console.log(`   ℹ️ No enemies → NEUTRAL`)
    return "neutral"
  }

  const mostThreatening = findMostThreateningEnemy(enemies, myBomber, myPos)

  if (!mostThreatening) {
    console.log(`   ℹ️ No threatening enemy found → NEUTRAL`)
    return "neutral"
  }

  const myPower = (myBomber.bombCount || 1) * (myBomber.explosionRange || 1) * (myBomber.speed || 1)
  const avgEnemyPower =
    enemies.reduce((sum, e) => {
      const b = e.bomber
      if (!b) return sum
      return sum + (b.bombCount || 1) * (b.explosionRange || 1) * (b.speed || 1)
    }, 0) / Math.max(enemies.length, 1)

  console.log(`   💪 Power Comparison:`)
  console.log(
    `      My Power: ${myPower.toFixed(1)} (bombs:${myBomber.bombCount} × range:${myBomber.explosionRange} × speed:${myBomber.speed})`,
  )
  console.log(`      Avg Enemy Power: ${avgEnemyPower.toFixed(1)}`)
  console.log(`      Power Ratio: ${(myPower / avgEnemyPower).toFixed(2)}x`)
  console.log(
    `      Threat Level: ${mostThreatening.level.toUpperCase()} (${mostThreatening.threat.toFixed(2)})`,
  )

  // CRITICAL: Check if we're in ENDGAME (few enemies, low resources)
  const isEndgame = enemies.length <= 3 && (resources.chestCount < 20 || resources.itemCount < 3)

  // ENDGAME: Ignore critical threats, fight aggressively!
  if (isEndgame && mostThreatening.level === "critical") {
    console.log(`   🎯 ENDGAME + Critical threat → OVERRIDE! Fight anyway!`)
    console.log(
      `      (Endgame: ${enemies.length} enemies, resources: items=${resources.itemCount}, chests=${resources.chestCount})`,
    )
    // Don't return "flee" - continue to endgame logic below
  } else if (mostThreatening.level === "critical") {
    // EARLY/MID GAME: Flee from critical threats
    console.log(`   🚨 Critical threat detected (NOT endgame) → FLEE`)
    return "flee"
  }

  // ENDGAME: Fight if few enemies left (1-3) - VERY aggressive!
  // REDUCED threshold to 50% - fight even when much weaker!
  if (enemies.length <= 3 && (resources.chestCount < 20 || resources.itemCount < 3)) {
    if (myPower >= avgEnemyPower * 0.5) {
      // Fight even if MUCH weaker - ultra aggressive endgame!
      console.log(
        `   🎯 ENDGAME condition met: ${enemies.length} enemies, low resources → FIGHT! (only need 50% power)`,
      )
      return "fight"
    } else {
      console.log(
        `   ⚠️ ENDGAME but too weak: need ${(avgEnemyPower * 0.5).toFixed(1)} power, have ${myPower.toFixed(1)}`,
      )
    }
  }

  // ULTRA AGGRESSIVE: Fight if we're stronger OR EQUAL
  // REDUCED to 1.0x - fight whenever not significantly weaker!
  if (myPower >= avgEnemyPower * 1.0 && (resources.itemCount > 5 || resources.chestCount > 3)) {
    console.log(
      `   ⚔️ Equal/stronger with resources (${(myPower / avgEnemyPower).toFixed(2)}x ≥ 1.0) → FIGHT!`,
    )
    return "fight"
  }

  // Fight if we're stronger and enemy is close
  if (myPower > avgEnemyPower && mostThreatening.distance < 5) {
    console.log(
      `   ⚔️ Stronger and enemy close (distance: ${mostThreatening.distance} < 5) → FIGHT!`,
    )
    return "fight"
  }

  // VERY AGGRESSIVE: Fight if we have ≥60% power (was 75%)
  // This makes bot ULTRA willing to fight
  if (enemies.length >= 1 && myPower >= avgEnemyPower * 0.6) {
    console.log(`   ⚔️ Decent power (${(myPower / avgEnemyPower).toFixed(2)}x ≥ 0.6) → FIGHT!`)
    return "fight"
  }

  // Only flee if outnumbered (3+) AND MUCH weaker (<50% power)
  // VERY AGGRESSIVE - only flee when truly hopeless!
  if (enemies.length >= 3 && myPower < avgEnemyPower * 0.5) {
    console.log(
      `   🏃 Heavily outnumbered (${enemies.length} enemies) and MUCH weaker (${(myPower / avgEnemyPower).toFixed(2)}x < 0.5) → FLEE!`,
    )
    return "flee"
  }

  // Default: FIGHT unless extremely dangerous
  // ULTRA AGGRESSIVE - prefer fighting over fleeing
  if (mostThreatening.threat > 0.8) {
    console.log(`   🏃 EXTREME threat level (${mostThreatening.threat.toFixed(2)} > 0.8) → FLEE!`)
    return "flee"
  } else if (mostThreatening.threat < 0.5) {
    console.log(`   ⚔️ Manageable threat (${mostThreatening.threat.toFixed(2)} < 0.5) → FIGHT!`)
    return "fight"
  }

  console.log(`   ⚔️ Medium threat → DEFAULT FIGHT! (${mostThreatening.threat.toFixed(2)})`)
  return "fight" // Changed from "neutral" to "fight" - always aggressive!
}
