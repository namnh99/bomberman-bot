import { manhattanDistance, posKey, isWalkable } from "../../utils/gridUtils.js"

/**
 * Evaluate zone control and territorial dominance
 * Returns safe zones and contested areas
 */
export function evaluateZoneControl(myPos, enemies, items, chests, map, explosionRange) {
  const zones = divideMapIntoZones(map)
  const zoneScores = []

  for (const zone of zones) {
    const score = scoreZone(zone, myPos, enemies, items, chests, explosionRange)
    zoneScores.push({
      zone,
      ...score,
    })
  }

  // Sort zones by safety and value
  zoneScores.sort((a, b) => {
    // Prioritize safe zones with resources
    const scoreA = a.safetyScore * 0.6 + a.resourceValue * 0.4
    const scoreB = b.safetyScore * 0.6 + b.resourceValue * 0.4
    return scoreB - scoreA
  })

  return {
    zones: zoneScores,
    controlledZone: zoneScores[0],
    dangerZones: zoneScores.filter((z) => z.safetyScore < 0.3),
    safeZones: zoneScores.filter((z) => z.safetyScore > 0.7),
  }
}

/**
 * Divide map into 9 zones (3x3 grid)
 */
function divideMapIntoZones(map) {
  const height = map.length
  const width = (map[0] && map[0].length) || 0

  const zoneHeight = Math.floor(height / 3)
  const zoneWidth = Math.floor(width / 3)

  const zones = []

  for (let zy = 0; zy < 3; zy++) {
    for (let zx = 0; zx < 3; zx++) {
      const zone = {
        id: `zone_${zx}_${zy}`,
        x: zx,
        y: zy,
        minX: zx * zoneWidth,
        maxX: (zx + 1) * zoneWidth - 1,
        minY: zy * zoneHeight,
        maxY: (zy + 1) * zoneHeight - 1,
        centerX: Math.floor((zx * zoneWidth + (zx + 1) * zoneWidth) / 2),
        centerY: Math.floor((zy * zoneHeight + (zy + 1) * zoneHeight) / 2),
      }
      zones.push(zone)
    }
  }

  return zones
}

/**
 * Score a zone based on safety and resources
 */
function scoreZone(zone, myPos, enemies, items, chests, explosionRange) {
  // Calculate distance from player
  const distanceToZone = manhattanDistance(myPos.x, myPos.y, zone.centerX, zone.centerY)

  // Count enemies in zone
  const enemiesInZone = enemies.filter(
    (e) => e.x >= zone.minX && e.x <= zone.maxX && e.y >= zone.minY && e.y <= zone.maxY,
  )

  // Count resources in zone
  const itemsInZone = items.filter(
    (i) => i.x >= zone.minX && i.x <= zone.maxX && i.y >= zone.minY && i.y <= zone.maxY,
  )

  const chestsInZone = chests.filter(
    (c) => c.x >= zone.minX && c.x <= zone.maxX && c.y >= zone.minY && c.y <= zone.maxY,
  )

  // Calculate nearest enemy distance
  let nearestEnemyDistance = Infinity
  for (const enemy of enemies) {
    const dist = manhattanDistance(zone.centerX, zone.centerY, enemy.x, enemy.y)
    nearestEnemyDistance = Math.min(nearestEnemyDistance, dist)
  }

  // Safety score (0-1)
  const baseSafety = enemiesInZone.length === 0 ? 1.0 : 0.3
  const distanceSafety = Math.min(1.0, nearestEnemyDistance / 10)
  const safetyScore = (baseSafety + distanceSafety) / 2

  // Resource value
  const resourceValue = itemsInZone.length * 5 + chestsInZone.length * 3

  // Distance penalty
  const distancePenalty = Math.max(0, 1 - distanceToZone * 0.05)

  return {
    safetyScore,
    resourceValue,
    enemyCount: enemiesInZone.length,
    itemCount: itemsInZone.length,
    chestCount: chestsInZone.length,
    distance: distanceToZone,
    overallScore: (safetyScore * 0.6 + (resourceValue / 20) * 0.4) * distancePenalty,
    isControlled: enemiesInZone.length === 0 && distanceToZone < 10,
    isContested: enemiesInZone.length > 0,
  }
}

// Removed unused functions:
// - findSafeRetreatPosition() - zone control retreat not implemented in agent.js
// - findFallbackRetreat() - helper for findSafeRetreatPosition
// - isInControlledTerritory() - zone control territory checking not implemented in agent.js
