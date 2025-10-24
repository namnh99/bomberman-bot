import { DIRS, GRID_SIZE, ITEMS } from "../../utils/constants.js"
import { toGridCoords, canExplosionReach, posKey, inBounds } from "../../utils/gridUtils.js"

/**
 * Calculate the value of chain reactions from a bomb placement
 * Returns total destruction area and triggered bombs
 */
export function calculateChainReactionValue(bombX, bombY, map, bombs, allBombers, myBomber) {
  const myRange = myBomber.explosionRange || 1
  const triggered = new Set()
  const destroyed = new Set()

  // Start with initial bomb
  const bombQueue = [
    {
      x: bombX,
      y: bombY,
      range: myRange,
      uid: myBomber.uid,
      isNew: true, // Our new bomb
    },
  ]

  triggered.add(posKey(bombX, bombY))

  while (bombQueue.length > 0) {
    const bomb = bombQueue.shift()

    // Mark all tiles hit by this bomb
    const hitTiles = getExplosionTiles(bomb.x, bomb.y, bomb.range, map)

    for (const tile of hitTiles) {
      destroyed.add(posKey(tile.x, tile.y))

      // Check if this tile has a bomb that we'll trigger
      if (!bomb.isNew) continue // Only check for our initial bomb triggering others

      for (const existingBomb of bombs) {
        const { x: bx, y: by } = toGridCoords(existingBomb.x, existingBomb.y)

        if (triggered.has(posKey(bx, by))) continue // Already triggered

        if (tile.x === bx && tile.y === by) {
          // This bomb will be triggered!
          const bomber = allBombers.find((b) => b.uid === existingBomb.uid)
          const range = (bomber && bomber.explosionRange) || existingBomb.explosionRange || 1

          triggered.add(posKey(bx, by))
          bombQueue.push({
            x: bx,
            y: by,
            range,
            uid: existingBomb.uid,
            isNew: false,
          })
        }
      }
    }
  }

  // Count valuable targets destroyed
  let chestsDestroyed = 0
  let itemsDestroyed = 0

  for (const tileKey of destroyed) {
    const [x, y] = tileKey.split(",").map(Number)
    if (!inBounds(x, y, map)) continue

    const cell = map[y][x]
    if (cell === "C") chestsDestroyed++
    if (ITEMS.includes(cell)) itemsDestroyed++
  }

  const chainBonus = (triggered.size - 1) * 20 // Bonus for each bomb triggered
  const destructionValue = chestsDestroyed * 10 + destroyed.size

  return {
    chainLength: triggered.size,
    triggeredBombs: triggered.size - 1,
    totalDestruction: destroyed.size,
    chestsDestroyed,
    itemsDestroyed,
    value: destructionValue + chainBonus,
    destroyedTiles: Array.from(destroyed),
  }
}

/**
 * Get all tiles hit by an explosion
 */
function getExplosionTiles(centerX, centerY, range, map) {
  const tiles = [{ x: centerX, y: centerY }]

  for (const [dx, dy] of DIRS) {
    for (let step = 1; step <= range; step++) {
      const nx = centerX + dx * step
      const ny = centerY + dy * step

      if (!inBounds(nx, ny, map)) break

      tiles.push({ x: nx, y: ny })

      const cell = map[ny][nx]
      // Explosions stop at walls/chests
      if (["W", "C"].includes(cell)) break
    }
  }

  return tiles
}

/**
 * Find best positions for chain reaction bombing
 */
export function findChainReactionOpportunities(
  myPos,
  map,
  bombs,
  allBombers,
  myBomber,
  maxDistance = 5,
) {
  const opportunities = []

  // Search area around player
  for (let dy = -maxDistance; dy <= maxDistance; dy++) {
    for (let dx = -maxDistance; dx <= maxDistance; dx++) {
      const bombX = myPos.x + dx
      const bombY = myPos.y + dy

      if (!inBounds(bombX, bombY, map)) continue

      const cell = map[bombY][bombX]
      // Can only place bombs on walkable tiles
      if (![".", "B", "R", "S"].includes(cell)) continue

      // Calculate chain reaction value
      const chainValue = calculateChainReactionValue(bombX, bombY, map, bombs, allBombers, myBomber)

      // Only consider if there's an actual chain (triggers other bombs)
      if (chainValue.triggeredBombs > 0) {
        opportunities.push({
          x: bombX,
          y: bombY,
          ...chainValue,
          distance: Math.abs(dx) + Math.abs(dy),
        })
      }
    }
  }

  // Sort by value (highest first)
  opportunities.sort((a, b) => b.value - a.value)

  return opportunities
}

/**
 * Check if bombing at position would create beneficial chain reaction
 * Returns true if chain destroys more chests than it destroys items
 */
export function isChainReactionWorthwhile(chainValue, riskTolerance = 0.5) {
  // Don't chain if it destroys valuable items (unless high risk tolerance)
  if (chainValue.itemsDestroyed > 0 && riskTolerance < 0.7) {
    return false
  }

  // Chain is worthwhile if:
  // 1. Triggers at least 1 other bomb
  // 2. Destroys at least 3 chests, OR
  // 3. Total destruction is significant
  const meetsThreshold =
    chainValue.triggeredBombs >= 1 &&
    (chainValue.chestsDestroyed >= 3 || chainValue.totalDestruction >= 10)

  return meetsThreshold
}
