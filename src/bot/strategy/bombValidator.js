import { findSafeTiles } from "../pathfinding/dangerMap.js"
import { findBestPath } from "../pathfinding/pathFinder.js"
import { toGridCoords } from "../../utils/gridUtils.js"
import { GRID_SIZE } from "../../utils/constants.js"

/**
 * Validate if bombing is safe by checking escape routes BEFORE committing
 * Returns { canBomb: boolean, escapePath: array, reason: string }
 */
export function validateBombSafety(bombPos, map, bombs, bombers, myBomber, myUid) {
  const { x: bx, y: by } = bombPos

  // Check if bomb already exists at this position
  const bombAlreadyHere = bombs.some((bomb) => {
    const { x, y } = toGridCoords(bomb.x, bomb.y)
    return x === bx && y === by
  })

  if (bombAlreadyHere) {
    return {
      canBomb: false,
      escapePath: null,
      reason: "bomb_exists",
    }
  }

  // Simulate future bomb state
  const futureBombs = [
    ...bombs,
    {
      x: bx * GRID_SIZE,
      y: by * GRID_SIZE,
      explosionRange: myBomber.explosionRange || 1,
      uid: myBomber.uid,
      timestamp: Date.now(), // Simulated bomb
    },
  ]

  // Find safe tiles after bombing
  const futureSafeTiles = findSafeTiles(map, futureBombs, bombers, myBomber)

  if (futureSafeTiles.length === 0) {
    return {
      canBomb: false,
      escapePath: null,
      reason: "no_safe_tiles",
    }
  }

  // Find escape path from bomb position
  const player = { x: bx, y: by }
  const escapePath = findBestPath(
    map,
    player,
    futureSafeTiles,
    futureBombs,
    bombers,
    myUid,
    true, // isEscape mode
  )

  if (!escapePath || escapePath.path.length === 0) {
    return {
      canBomb: false,
      escapePath: null,
      reason: "no_escape_path",
    }
  }

  // Check if escape is fast enough (should reach safety in time)
  const escapeTime = escapePath.path.length
  const bombTimer = 3 // 3 seconds typical bomb timer
  const mySpeed = myBomber.speed || 1
  const requiredTime = escapeTime / mySpeed

  if (requiredTime >= bombTimer) {
    return {
      canBomb: false,
      escapePath: escapePath.path,
      reason: "escape_too_slow",
      escapeTime: requiredTime,
    }
  }

  return {
    canBomb: true,
    escapePath: escapePath.path,
    escapeAction: escapePath.path[0],
    reason: "safe",
    safeTilesCount: futureSafeTiles.length,
  }
}

/**
 * Pre-validate multiple bomb positions and return best option
 */
export function findBestSafeBombPosition(positions, map, bombs, bombers, myBomber, myUid) {
  const validPositions = []

  for (const pos of positions) {
    const validation = validateBombSafety(pos, map, bombs, bombers, myBomber, myUid)

    if (validation.canBomb) {
      validPositions.push({
        ...pos,
        validation,
        escapeLength: validation.escapePath.length,
      })
    }
  }

  if (validPositions.length === 0) return null

  // Sort by escape path length (shorter is better)
  validPositions.sort((a, b) => a.escapeLength - b.escapeLength)

  return validPositions[0]
}

/**
 * Quick check if current position is safe to bomb from
 */
export function canSafelyBombCurrentPosition(myPos, map, bombs, bombers, myBomber, myUid) {
  return validateBombSafety(myPos, map, bombs, bombers, myBomber, myUid)
}
