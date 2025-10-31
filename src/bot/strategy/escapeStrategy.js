import { DIRS } from "../../utils/constants.js"
import { toGridCoords, posKey, isWalkable } from "../../utils/gridUtils.js"
import { findSafeTiles, findUnsafeTiles } from "../pathfinding/dangerMap.js"
import { findBestPath, findShortestEscapePath } from "../pathfinding/pathFinder.js"
import { wouldMoveTrapUs } from "../pathfinding/riskEvaluator.js"
import { isTileSafeByTime } from "../pathfinding/safetyEvaluator.js"
import { findAdvancedEscapePath, detectBombChains } from "./advancedEscape.js"
import { findPrioritizedEscapeDirection } from "../pathfinding/escapeDirectionSelector.js"
import { detectTrapSituation, suggestEvasiveAction } from "./antiTrapStrategy.js"
import { findSafeWaitingPosition } from "./stagedEscape.js"

// Escape reversal protection: avoid ping-pong between two tiles
let lastEscapeFrom = null
let lastEscapeTo = null
let lastEscapeTime = 0
const ESCAPE_REVERSAL_COOLDOWN_MS = 2000

/**
 * Try to escape from danger using advanced multi-bomb analysis
 */
export function attemptEscape(map, player, bombs, bombers, myBomber, myUid) {
  console.log(`   🚨 UNSAFE at [${player.x}, ${player.y}]! Finding escape route...`)

  // Filter to only relevant bombs (nearby bombs that affect the bot)
  const relevantBombs = bombs.filter((bomb) => {
    if (bomb.isExploded) return false
    const distance = Math.abs(bomb.x - player.x) + Math.abs(bomb.y - player.y)
    return distance <= 8 // Only consider bombs within 8 tiles
  })

  // Check for bomb chains first
  if (relevantBombs.length >= 3) {
    const chains = detectBombChains(bombs, bombers, map)
    if (chains.length > 0) {
      console.log(`   ⚠️ Detected ${chains.length} bomb chain(s)!`)
      const advancedEscape = findAdvancedEscapePath(player, map, bombs, bombers, myBomber)

      if (advancedEscape && advancedEscape.path) {
        console.log(`   ✅ Advanced chain-aware escape: ${advancedEscape.path.join(" → ")}`)
        console.log(`🎯 DECISION: ESCAPE (chain-aware)`)
        console.log("=".repeat(90) + "\n")
        return {
          action: advancedEscape.path[0],
          isEscape: true,
          fullPath: advancedEscape.path,
        }
      }
    }
  }

  // PRIORITY 0.5: Check for staged escape opportunity (multi-bomb)
  // If we have multiple bombs with different timings, might be better to:
  // 1. Move to position safe from FASTEST bomb
  // 2. Wait for it to explode
  // 3. Then escape from remaining bombs (easier terrain, better timing)
  if (relevantBombs.length >= 2) {
    // NOTE: player is already in grid coordinates (converted in agent.js)
    const waitStrategy = findSafeWaitingPosition(player, map, bombs, bombers, myUid)

    if (waitStrategy) {
      console.log(`   💡 STAGED ESCAPE STRATEGY AVAILABLE:`)
      console.log(`      ${waitStrategy.reason}`)

      // Check if we should STAY at current position
      if (waitStrategy.isStayingInPlace) {
        console.log(
          `      🛑 STAYING at current position [${player.x}, ${player.y}] for ${(waitStrategy.waitTime / 1000).toFixed(1)}s`,
        )
        console.log(`🎯 DECISION: ESCAPE (staged - stay and wait for fast bomb)`)
        console.log("=".repeat(90) + "\n")

        return {
          action: "STAY",
          isEscape: true,
          isWaitingStrategy: true,
          waitPosition: waitStrategy.waitPosition,
          waitTime: waitStrategy.waitTime,
        }
      }

      // Otherwise, move to the waiting position
      console.log(
        `      📍 Move to [${waitStrategy.waitPosition.x}, ${waitStrategy.waitPosition.y}] and wait ${(waitStrategy.waitTime / 1000).toFixed(1)}s`,
      )

      // Path to waiting position
      const waitPath = findBestPath(
        map,
        player,
        [waitStrategy.waitPosition],
        bombs,
        bombers,
        myUid,
        false, // Don't need strict mode for waiting position
      )

      if (waitPath && waitPath.path.length > 0) {
        console.log(`      ✅ Path to waiting position: ${waitPath.path.join(" → ")}`)
        console.log(`🎯 DECISION: ESCAPE (staged - move and wait for fast bomb)`)
        console.log("=".repeat(90) + "\n")

        return {
          action: waitPath.path[0],
          isEscape: true,
          fullPath: waitPath.path,
          isWaitingStrategy: true,
          waitPosition: waitStrategy.waitPosition,
        }
      } else {
        console.log(`      ❌ Cannot path to waiting position`)
      }
    }
  }

  // PRIORITY 1: Try path-based escape first (prevents ping-pong)
  // This finds a complete escape path, not just next step
  const escapeResult = findShortestEscapePath(map, player, bombs, bombers, myBomber)

  if (escapeResult && escapeResult.path.length > 0) {
    // ===== ESCAPE REVERSAL PROTECTION =====
    // Check if this escape would immediately reverse our last escape (A->B then B->A)
    const now = Date.now()
    const currentPos = posKey(player.x, player.y)
    const targetPos = posKey(escapeResult.target.x, escapeResult.target.y)

    if (
      lastEscapeFrom &&
      lastEscapeTo &&
      currentPos === lastEscapeTo &&
      targetPos === lastEscapeFrom &&
      now - lastEscapeTime < ESCAPE_REVERSAL_COOLDOWN_MS
    ) {
      console.log(
        `   ⚠️ Detected immediate escape reversal attempt — suppressing to avoid ping-pong`,
      )
      console.log(
        `   Last escape: ${lastEscapeFrom} -> ${lastEscapeTo}, attempting: ${currentPos} -> ${targetPos}`,
      )

      // Try to find a DIFFERENT safe tile (not the reversal target)
      const safeTiles = findSafeTiles(map, bombs, bombers, myBomber)
      const otherSafeTiles = safeTiles.filter(
        (t) => posKey(t.x, t.y) !== lastEscapeFrom && posKey(t.x, t.y) !== currentPos,
      )

      if (otherSafeTiles.length > 0) {
        console.log(`   🔍 Trying ${otherSafeTiles.length} alternative safe tiles...`)
        const altPath = findBestPath(map, player, otherSafeTiles, bombs, bombers, myUid, true)
        if (altPath && altPath.path.length > 0) {
          console.log(`   ✅ Found alternative escape: ${altPath.path.join(" → ")}`)

          // Calculate target position from first move
          const altTargetPos = posKey(
            altPath.path[0] === "LEFT"
              ? player.x - 1
              : altPath.path[0] === "RIGHT"
                ? player.x + 1
                : player.x,
            altPath.path[0] === "UP"
              ? player.y - 1
              : altPath.path[0] === "DOWN"
                ? player.y + 1
                : player.y,
          )

          // Record this escape
          lastEscapeFrom = currentPos
          lastEscapeTo = altTargetPos
          lastEscapeTime = now

          console.log("🎯 DECISION: ESCAPE (alternative to avoid reversal)")
          console.log("   Action:", altPath.path[0])
          console.log("=".repeat(90) + "\n")

          return {
            action: altPath.path[0],
            isEscape: true,
            fullPath: altPath.path,
          }
        }
      }

      // If no alternative, try emergency escape
      console.log(`   ⚠️ No alternative escape found - trying emergency escape`)
      return attemptEmergencyEscape(map, player, bombs, bombers, myBomber)
    }
    // ===== END REVERSAL PROTECTION =====

    // Validate the first move doesn't trap us
    const firstMovePos = getNextPosition(player, escapeResult.path[0])
    const wouldTrap = wouldMoveTrapUs(player, firstMovePos, map, bombs, [])

    if (wouldTrap) {
      console.log(`   ⚠️ Escape path would trap us! Trying alternative...`)
      return attemptEmergencyEscape(map, player, bombs, bombers, myBomber)
    }

    console.log(`   ✅ Shortest escape path found: ${escapeResult.path.join(" → ")}`)
    console.log(`   Target safe tile: [${escapeResult.target.x}, ${escapeResult.target.y}]`)
    console.log(`   Distance: ${escapeResult.distance} steps`)
    console.log("🎯 DECISION: ESCAPE (shortest path to safety)")
    console.log("   Action:", escapeResult.path[0])
    console.log("=".repeat(90) + "\n")

    // Record this escape to detect future reversals
    lastEscapeFrom = currentPos
    lastEscapeTo = targetPos
    lastEscapeTime = now

    return {
      action: escapeResult.path[0],
      isEscape: true,
      fullPath: escapeResult.path,
    }
  }

  // FALLBACK: If path-based escape fails in multi-bomb zone, try timing-based direction
  if (relevantBombs.length >= 2) {
    console.log(`   🕐 Path-based escape failed - trying timing-optimized direction...`)

    // Check if bot is trapped by enemies
    const gridPos = toGridCoords(player.x, player.y)
    const trapInfo = detectTrapSituation(gridPos, map, bombs, bombers, myUid)

    if (trapInfo.isTrapped && trapInfo.severity >= 3) {
      console.log(`   🚨 TRAP DETECTED: ${trapInfo.analysis}`)
      console.log(
        `      Escape routes: ${trapInfo.escapeRoutes} walkable, ${trapInfo.safeRoutes} safe`,
      )
      console.log(
        `      Blocked by: ${trapInfo.blockedByBombs} bombs, ${trapInfo.blockedByWalls} walls`,
      )

      // Try evasive action
      const evasiveAction = suggestEvasiveAction(trapInfo, gridPos, map, bombs, bombers, myUid)

      if (evasiveAction && !evasiveAction.isFatal) {
        console.log(`   💨 EVASIVE ACTION: ${evasiveAction.action}`)
        console.log(`      Reason: ${evasiveAction.reason}`)
        console.log(`🎯 DECISION: ESCAPE (evasive maneuver)`)
        console.log("=".repeat(90) + "\n")
        return {
          action: evasiveAction.action,
          isEscape: true,
          fullPath: [evasiveAction.action],
        }
      } else if (evasiveAction) {
        console.log(`   💀 ${evasiveAction.reason}`)
        console.log(`   ⚰️  Bot is in FATAL trap - death imminent`)
      }
    }

    const prioritizedDir = findPrioritizedEscapeDirection(map, gridPos, bombs, bombers, myUid)

    if (prioritizedDir) {
      console.log(`   ✅ Using timing-optimized direction: ${prioritizedDir}`)
      console.log(`🎯 DECISION: ESCAPE (timing-optimized fallback)`)
      console.log("=".repeat(90) + "\n")
      return {
        action: prioritizedDir,
        isEscape: true,
        fullPath: [prioritizedDir],
      }
    } else {
      console.log(`   ❌ Timing-optimized escape also failed (all directions have negative margin)`)
      console.log(`   💀 Bot is in FATAL position - no viable escape possible`)
    }
  }

  return null
}

/**
 * Get next position after a move
 */
function getNextPosition(current, action) {
  const moves = {
    UP: { x: current.x, y: current.y - 1 },
    DOWN: { x: current.x, y: current.y + 1 },
    LEFT: { x: current.x - 1, y: current.y },
    RIGHT: { x: current.x + 1, y: current.y },
  }
  return moves[action] || current
}

/**
 * Try emergency moves when no clear escape path exists
 */
export function attemptEmergencyEscape(map, player, bombs, bombers, myBomber) {
  console.log("   ⚠️ No direct escape path, trying emergency moves...")
  const unsafeTiles = findUnsafeTiles(map, bombs, bombers)
  const currentSpeed = myBomber.speed || 1

  // ANTI PING-PONG: Don't reverse direction immediately
  const now = Date.now()
  const shouldAvoidReversal = now - lastEscapeTime < ESCAPE_REVERSAL_COOLDOWN_MS

  if (shouldAvoidReversal && lastEscapeFrom && lastEscapeTo) {
    const wouldReverse =
      posKey(player.x, player.y) === lastEscapeTo && posKey(lastEscapeFrom) === lastEscapeFrom
    if (wouldReverse) {
      console.log(
        `   🔄 ANTI-PING-PONG: Avoiding reversal from [${lastEscapeTo}] back to [${lastEscapeFrom}]`,
      )
    }
  }

  // Calculate "best" direction - prefer moving AWAY from bombs, not towards them
  const bombDistances = new Map()

  for (const [dx, dy, dir] of DIRS) {
    const nx = player.x + dx
    const ny = player.y + dy

    // Calculate minimum distance to any bomb
    let minDistToBomb = Infinity
    for (const bomb of bombs) {
      const { x: bx, y: by } = toGridCoords(bomb.x, bomb.y)
      const dist = Math.abs(nx - bx) + Math.abs(ny - by)
      minDistToBomb = Math.min(minDistToBomb, dist)
    }
    bombDistances.set(dir, minDistToBomb)
  }

  // First pass: time-safe tiles - prioritize those FARTHER from bombs
  // EMERGENCY MODE: Use minimal buffers to find ANY possible escape
  const timeSafeMoves = []
  for (const [dx, dy, dir] of DIRS) {
    const nx = player.x + dx
    const ny = player.y + dy

    if (!isWalkable(nx, ny, map)) continue

    const key = posKey(nx, ny)
    const isBombTile = bombs.some((bomb) => {
      const { x, y } = toGridCoords(bomb.x, bomb.y)
      return x === nx && y === ny
    })

    // CRITICAL: Use EMERGENCY MODE (minimal buffers) for desperate situations
    const willBeSafe = isTileSafeByTime(nx, ny, 1, bombs, bombers, map, currentSpeed, true)

    if (willBeSafe && !isBombTile) {
      timeSafeMoves.push({ dir, nx, ny, dist: bombDistances.get(dir) })
    }
  }

  // Sort by distance from bombs (prefer farther)
  timeSafeMoves.sort((a, b) => b.dist - a.dist)

  // ANTI-PING-PONG: Filter out reversal moves (check BOTH lastEscapeFrom and lastEscapeTo)
  const nonReversalMoves = shouldAvoidReversal
    ? timeSafeMoves.filter((m) => {
        const targetKey = posKey(m.nx, m.ny)
        // Don't go back to EITHER the previous position OR the one before that
        return targetKey !== lastEscapeFrom && targetKey !== lastEscapeTo
      })
    : timeSafeMoves

  if (nonReversalMoves.length > 0) {
    const best = nonReversalMoves[0]
    console.log(
      `   ✅ Time-safe emergency move: ${best.dir} to [${best.nx}, ${best.ny}] (${best.dist} tiles from nearest bomb)`,
    )
    console.log("🎯 DECISION: EMERGENCY ESCAPE (time-safe tile)")
    console.log("   Action:", best.dir)
    console.log("=".repeat(90) + "\n")

    // Track escape for anti-ping-pong (shift the history)
    lastEscapeFrom = lastEscapeTo // Previous destination becomes old position
    lastEscapeTo = posKey(best.nx, best.ny) // New destination
    lastEscapeTime = now

    return { action: best.dir }
  }

  // Second pass: currently safe tiles - prioritize farther from bombs
  const currentlySafeMoves = []
  for (const [dx, dy, dir] of DIRS) {
    const nx = player.x + dx
    const ny = player.y + dy

    if (!isWalkable(nx, ny, map)) continue

    const key = posKey(nx, ny)
    const isBombTile = bombs.some((bomb) => {
      const { x, y } = toGridCoords(bomb.x, bomb.y)
      return x === nx && y === ny
    })

    if (!unsafeTiles.has(key) && !isBombTile) {
      currentlySafeMoves.push({ dir, nx, ny, dist: bombDistances.get(dir) })
    }
  }

  currentlySafeMoves.sort((a, b) => b.dist - a.dist)

  if (currentlySafeMoves.length > 0) {
    const best = currentlySafeMoves[0]
    console.log(
      `   ⚠️ Currently safe emergency move: ${best.dir} to [${best.nx}, ${best.ny}] (${best.dist} tiles from bomb, but may explode!)`,
    )
    console.log("🎯 DECISION: EMERGENCY ESCAPE (currently safe)")
    console.log("   Action:", best.dir)
    console.log("=".repeat(90) + "\n")

    return { action: best.dir }
  }

  // Third pass: any walkable tile - LAST RESORT, prefer farther from bombs
  const desperateMoves = []
  for (const [dx, dy, dir] of DIRS) {
    const nx = player.x + dx
    const ny = player.y + dy

    if (!isWalkable(nx, ny, map)) continue

    const isBombTile = bombs.some((bomb) => {
      const { x, y } = toGridCoords(bomb.x, bomb.y)
      return x === nx && y === ny
    })

    if (!isBombTile) {
      desperateMoves.push({ dir, nx, ny, dist: bombDistances.get(dir) })
    }
  }

  desperateMoves.sort((a, b) => b.dist - a.dist)

  // ANTI-PING-PONG: Filter desperate moves too
  const nonReversalDesperateMoves = shouldAvoidReversal
    ? desperateMoves.filter((m) => {
        const targetKey = posKey(m.nx, m.ny)
        // Don't go back to EITHER the previous position OR the one before that
        return targetKey !== lastEscapeFrom && targetKey !== lastEscapeTo
      })
    : desperateMoves

  if (nonReversalDesperateMoves.length > 0) {
    const best = nonReversalDesperateMoves[0]
    console.log(
      `   🚨 DESPERATE: Moving ${best.dir} to [${best.nx}, ${best.ny}] (${best.dist} tiles from bomb, STILL IN DANGER!)`,
    )
    console.log("🎯 DECISION: EMERGENCY ESCAPE (desperate)")
    console.log("   Action:", best.dir)
    console.log("=".repeat(90) + "\n")

    // Track escape for anti-ping-pong (shift the history)
    lastEscapeFrom = lastEscapeTo // Previous destination becomes old position
    lastEscapeTo = posKey(best.nx, best.ny) // New destination
    lastEscapeTime = now

    return { action: best.dir }
  }

  // If ALL moves are blocked by anti-ping-pong, we're truly stuck in a deadlock
  // In this case, STAYING is better than ping-ponging (wastes time, same death)
  if (desperateMoves.length > 0) {
    console.log(
      `   ⛔ DEADLOCK: Trapped in ${desperateMoves.length}-tile corridor, all moves cause ping-pong!`,
    )
    console.log(`      Current: [${player.x}, ${player.y}]`)
    console.log(`      Last escape: [${lastEscapeFrom}] → [${lastEscapeTo}]`)
    console.log(
      `      Available moves would be: ${desperateMoves.map((m) => `${m.dir} to [${m.nx},${m.ny}]`).join(", ")}`,
    )
    console.log(`   🛑 STAYING PUT - accepting fate rather than wasting time ping-ponging`)
    console.log("🎯 DECISION: EMERGENCY ESCAPE (deadlock - staying)")
    console.log("   Action: null (STAY)")
    console.log("=".repeat(90) + "\n")

    // Reset anti-ping-pong tracking to allow future escapes if bombs explode
    lastEscapeFrom = null
    lastEscapeTo = null
    lastEscapeTime = 0

    return null // STAY - don't move
  }

  return null
}

/**
 * Check if player is currently safe from bombs
 */
export function checkSafety(map, player, bombs, bombers, myBomber) {
  const safeTiles = findSafeTiles(map, bombs, bombers, myBomber)
  const unsafeTiles = findUnsafeTiles(map, bombs, bombers)

  const isPlayerSafe = bombs.length
    ? safeTiles.some((tile) => tile.x === player.x && tile.y === player.y)
    : true

  // CRITICAL: Check if there are nearby bombs about to explode soon (urgency check)
  // IMPORTANT: Only treat as urgent if player is ACTUALLY in blast zone OR very close to bomb
  const now = Date.now()
  const URGENCY_THRESHOLD = 3000 // 3 seconds
  const URGENCY_PROXIMITY = 2 // Only urgent if bomb is 2 or fewer tiles away (within potential blast range)

  let hasUrgentThreat = false
  if (bombs.length > 0) {
    for (const bomb of bombs) {
      if (bomb.isExploded) continue

      const { x: bombX, y: bombY } = toGridCoords(bomb.x, bomb.y)
      const distance = Math.abs(bombX - player.x) + Math.abs(bombY - player.y)

      // CRITICAL: Check if player is IN BLAST ZONE of this bomb first
      const isInBlastZone = unsafeTiles.has(posKey(player.x, player.y))

      // Check if bomb is nearby AND either in blast zone OR VERY close (adjacent)
      if ((isInBlastZone && distance <= URGENCY_PROXIMITY) || distance <= 1) {
        const bombCreatedAt = bomb.createdAt || now
        const bombLifeTime = bomb.lifeTime || 5000
        const timeUntilExplosion = bombLifeTime - (now - bombCreatedAt)

        if (timeUntilExplosion > 0 && timeUntilExplosion <= URGENCY_THRESHOLD) {
          console.log(
            `   ⚠️ URGENT: Bomb at [${bombX},${bombY}] exploding in ${(timeUntilExplosion / 1000).toFixed(1)}s (${distance} tiles away${isInBlastZone ? ", IN BLAST ZONE" : ""})`,
          )
          hasUrgentThreat = true
          break
        }
      }
    }
  }

  // Override safety status if urgent threat detected
  const finalSafetyStatus = isPlayerSafe && !hasUrgentThreat

  console.log(`   Safety Status: ${finalSafetyStatus ? "✅ SAFE" : "🚨 DANGER"}`)
  if (hasUrgentThreat && isPlayerSafe) {
    console.log(`   ⚠️ Overriding to DANGER due to urgent bomb threat nearby`)
  }
  console.log(`   Safe Tiles Available: ${safeTiles.length}`)

  return { isPlayerSafe: finalSafetyStatus, safeTiles }
}
