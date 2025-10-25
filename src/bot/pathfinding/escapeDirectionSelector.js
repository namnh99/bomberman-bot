import { DIRS, WALKABLE } from "../../utils/constants.js"
import { inBounds, posKey } from "../../utils/gridUtils.js"
import { findUnsafeTiles, createBombTileMap } from "./dangerMap.js"
import { getSafeTimeMargin } from "./safetyEvaluator.js"

/**
 * Find IMMEDIATE escape direction prioritizing slower-exploding bombs
 * When surrounded by multiple bombs, prefer direction towards bomb that explodes later
 * This allows bot to navigate through dense bomb zones by choosing safer timing
 *
 * @param {Array} map - Game map
 * @param {Object} start - Current position {x, y}
 * @param {Array} bombs - Active bombs
 * @param {Array} allBombers - All bombers
 * @param {string} myUid - Player UID
 * @returns {string|null} - Best immediate direction (UP/DOWN/LEFT/RIGHT) or null
 */
export function findPrioritizedEscapeDirection(map, start, bombs, allBombers, myUid) {
  const myBomber = allBombers.find((b) => b.uid === myUid)
  const currentSpeed = myBomber?.speed || 1
  const unsafeTiles = findUnsafeTiles(map, bombs, allBombers)
  const bombTiles = createBombTileMap(bombs)

  // Evaluate all 4 directions
  const directionScores = []

  for (const [dx, dy, dir] of DIRS) {
    const nx = start.x + dx
    const ny = start.y + dy
    const key = posKey(nx, ny)

    // Skip if out of bounds
    if (!inBounds(nx, ny, map)) continue

    // Skip if there's a non-walkable bomb
    const bombAtTile = bombTiles.get(key)
    if (bombAtTile && !bombAtTile.walkable) continue

    // Skip if not walkable terrain
    if (!WALKABLE.includes(map[ny][nx])) continue

    // Calculate safe time margin for this direction (1 step away)
    const timeMargin = getSafeTimeMargin(nx, ny, 1, bombs, allBombers, map, currentSpeed)

    // Check if tile is currently in danger zone
    const isInDanger = unsafeTiles.has(key)

    directionScores.push({
      direction: dir,
      x: nx,
      y: ny,
      timeMargin,
      isInDanger,
    })
  }

  if (directionScores.length === 0) {
    console.log("   ❌ No valid escape directions available!")
    return null
  }

  // Sort by priority:
  // 1. Among tiles in danger, prefer HIGHER time margin (slower bomb) - STRATEGIC WAIT
  // 2. Safe tiles are preferred only if danger tiles have insufficient time
  directionScores.sort((a, b) => {
    // STRATEGIC PRIORITY: If both are in danger zones, choose the slower-exploding one
    // This allows "waiting" in slow-bomb zone to avoid fast-bomb zone
    if (a.isInDanger && b.isInDanger) {
      return b.timeMargin - a.timeMargin // Higher margin = more time = better
    }

    // If one is safe and one is danger, check if danger has enough time (>1.5s)
    if (a.isInDanger && !b.isInDanger) {
      // a is danger, b is safe
      // If danger zone has good time margin (>1.5s), prefer it strategically
      return a.timeMargin > 1500 ? -1 : 1
    }
    if (!a.isInDanger && b.isInDanger) {
      // a is safe, b is danger
      return b.timeMargin > 1500 ? 1 : -1
    }

    // Both safe - prefer higher time margin (farther from bombs)
    return b.timeMargin - a.timeMargin
  })

  const best = directionScores[0]

  console.log("   🎯 Escape direction priorities (by bomb timing):")
  directionScores.forEach((d, i) => {
    const icon = i === 0 ? "✅" : "  "
    const dangerIcon = d.isInDanger ? "⚠️" : "✓"
    const marginStr =
      d.timeMargin === Infinity ? "∞ (safe)" : `${(d.timeMargin / 1000).toFixed(1)}s`
    console.log(
      `      ${icon} ${dangerIcon} ${d.direction} → [${d.x},${d.y}] | time margin: ${marginStr}`,
    )
  })

  // Log strategic decision
  if (best.isInDanger && best.timeMargin > 1500) {
    console.log(
      `   🎲 STRATEGIC: Entering slow-bomb zone (${(best.timeMargin / 1000).toFixed(1)}s margin) to avoid faster bombs`,
    )
  }

  return best.direction
}
