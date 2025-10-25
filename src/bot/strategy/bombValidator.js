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
  // Use more accurate timing calculation based on GRID_SIZE and STEP_DELAY
  const STEP_DELAY = 20 // ms per step
  const stepsNeeded = escapePath.path.length

  // Calculate time to reach safety with accurate speed formula:
  // Time per grid cell = (GRID_SIZE / speed) * STEP_DELAY
  const timePerStep = (GRID_SIZE / myBomber.speed) * STEP_DELAY

  // Add alignment overhead: each move may need up to half a grid cell alignment
  // Conservative estimate: add 50% overhead for alignment
  const alignmentOverhead = timePerStep * 0.5

  // Total escape time with alignment
  const totalEscapeTime = stepsNeeded * timePerStep + alignmentOverhead // in milliseconds

  // Bomb timer from server (typically 5000ms)
  const BOMB_EXPLOSION_TIME = futureBombs[futureBombs.length - 1]?.lifeTime || 5000

  // We need a LARGE safety buffer - accounting for:
  // 1. Network delays (200-300ms)
  // 2. Alignment overhead (already added above)
  // 3. Server tick sync (20-40ms)
  // Buffer scales with speed - slower movement needs more buffer
  const speedSafetyFactor = Math.max(1, 2 / myBomber.speed)
  const ESCAPE_SAFETY_BUFFER = 1200 * speedSafetyFactor // 1.2-2.4s safety margin (speed-dependent)
  const availableTime = BOMB_EXPLOSION_TIME - ESCAPE_SAFETY_BUFFER

  console.log(
    `   ⏱️  Escape timing: ${stepsNeeded} steps × ${timePerStep.toFixed(0)}ms + ${alignmentOverhead.toFixed(0)}ms align = ${totalEscapeTime.toFixed(0)}ms | Available: ${availableTime.toFixed(0)}ms (buffer: ${ESCAPE_SAFETY_BUFFER.toFixed(0)}ms)`,
  )

  if (totalEscapeTime >= availableTime) {
    return {
      canBomb: false,
      escapePath: escapePath.path,
      reason: "escape_too_slow",
      escapeTime: totalEscapeTime,
      availableTime: availableTime,
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
