import { findSafeTiles, findUnsafeTiles } from "../pathfinding/dangerMap.js"
import { findBestPath } from "../pathfinding/pathFinder.js"
import { toGridCoords } from "../../utils/gridUtils.js"
import { GRID_SIZE } from "../../utils/constants.js"
import { createFutureBomb } from "../helpers/index.js"

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
  const futureBombs = [...bombs, createFutureBomb(bx, by, myBomber.explosionRange, myBomber.uid)]

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
  // CRITICAL: Use STRICT mode - must NOT cross blast zones (no timing-based)
  // This is a FUTURE bomb we're about to place, so we need GUARANTEED escape
  const player = { x: bx, y: by }
  const escapePath = findBestPath(
    map,
    player,
    futureSafeTiles,
    futureBombs,
    bombers,
    myUid,
    true,   // isEscape mode
    false,  // allowTimingBasedCrossing = FALSE (strictly safe!)
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

  // We need a balanced safety buffer - accounting for:
  // 1. WebSocket network delays (50-100ms typically, not 200-300ms)
  // 2. Alignment overhead (already added above)
  // 3. Server tick sync (20-40ms)
  // 4. Movement delays and obstacles (50-100ms)
  //
  // ADAPTIVE BUFFER: Lower buffer when bot has many bombs (aggressive play)
  // Higher buffer when bot has few bombs (conservative play)
  const bombCountFactor = Math.max(0.7, Math.min(1.0, myBomber.bombCount / 3)) // 0.7-1.0x based on bomb count

  // Buffer scales with speed - slower movement needs more buffer
  const speedSafetyFactor = Math.max(1, 2 / myBomber.speed)

  // OPTIMIZED BUFFER for WebSocket: 800-1600ms (reduced from 1200-2400ms)
  // With bombCountFactor: 560-1600ms (more aggressive with more bombs)
  const BASE_BUFFER = 800 * speedSafetyFactor
  const ESCAPE_SAFETY_BUFFER = BASE_BUFFER * bombCountFactor
  const availableTime = BOMB_EXPLOSION_TIME - ESCAPE_SAFETY_BUFFER

  console.log(
    `   ⏱️  Escape timing: ${stepsNeeded} steps × ${timePerStep.toFixed(0)}ms + ${alignmentOverhead.toFixed(0)}ms align = ${totalEscapeTime.toFixed(0)}ms`,
  )
  console.log(
    `   📊 Buffer: ${ESCAPE_SAFETY_BUFFER.toFixed(0)}ms (base ${BASE_BUFFER.toFixed(0)}ms × bombCount ${bombCountFactor.toFixed(2)}x) | Available: ${availableTime.toFixed(0)}ms`,
  )

  if (totalEscapeTime >= availableTime) {
    console.log(
      `   ❌ ESCAPE TOO SLOW: Need ${totalEscapeTime.toFixed(0)}ms but only ${availableTime.toFixed(0)}ms available - REFUSING TO BOMB (suicide prevention)`,
    )
    return {
      canBomb: false,
      escapePath: escapePath.path,
      reason: "escape_too_slow",
      escapeTime: totalEscapeTime,
      availableTime: availableTime,
    }
  }

  // CRITICAL SAFETY CHECK: Verify escape destination is truly safe
  // Calculate where bot will end up after escape
  let finalX = bx
  let finalY = by
  for (const step of escapePath.path) {
    if (step === "UP") finalY--
    else if (step === "DOWN") finalY++
    else if (step === "LEFT") finalX--
    else if (step === "RIGHT") finalX++
  }

  // Check if final position is in danger zone
  const unsafeTilesAfterBomb = findUnsafeTiles(map, futureBombs, bombers)
  const finalPosKey = `${finalX},${finalY}`
  if (unsafeTilesAfterBomb.has(finalPosKey)) {
    console.log(
      `   ❌ ESCAPE DESTINATION UNSAFE: [${finalX}, ${finalY}] is in blast zone - REFUSING TO BOMB (suicide prevention)`,
    )
    return {
      canBomb: false,
      escapePath: null,
      reason: "unsafe_destination",
    }
  }

  // CRITICAL: Check if escape destination itself is TRAPPED (no further escape possible)
  // This prevents scenarios where bot escapes immediate bomb but gets trapped by multiple bombs
  const escapeDestPos = { x: finalX, y: finalY }
  const secondEscapePath = findBestPath(
    map,
    escapeDestPos,
    futureSafeTiles,
    futureBombs,
    bombers,
    myUid,
    true,   // isEscape mode
    false,  // allowTimingBasedCrossing = FALSE (strictly safe for future bomb!)
  )

  if (!secondEscapePath || secondEscapePath.path.length === 0) {
    console.log(
      `   ❌ ESCAPE DESTINATION TRAPPED: [${finalX}, ${finalY}] has no further escape - REFUSING TO BOMB (deadlock prevention)`,
    )
    console.log(
      `      (Can escape immediate bomb, but will be trapped by surrounding bombs/walls)`,
    )
    return {
      canBomb: false,
      escapePath: null,
      reason: "escape_trapped",
    }
  }

  console.log(
    `   ✅ BOMB VALIDATED: Escape to [${finalX}, ${finalY}] is safe with ${(availableTime - totalEscapeTime).toFixed(0)}ms margin`,
  )
  console.log(
    `      Secondary escape available: ${secondEscapePath.path.length > 0 ? secondEscapePath.path.join(" → ") : "already safe"}`,
  )

  return {
    canBomb: true,
    escapePath: escapePath.path,
    escapeCoordinates: escapePath.fullPathCoordinates || [],
    escapeAction: escapePath.path[0],
    reason: "safe",
    safeTilesCount: futureSafeTiles.length,
  }
}
