import { GRID_SIZE, DIRS, WALKABLE } from "../../utils/constants.js"
import { toGridCoords, posKey, isWalkable, isAdjacent } from "../../utils/gridUtils.js"
import { findSafeTiles, findUnsafeTiles } from "../pathfinding/dangerMap.js"
import { findBestPath, findShortestEscapePath } from "../pathfinding/pathFinder.js"
import { wouldMoveTrapUs } from "../pathfinding/riskEvaluator.js"
import { isTileSafeByTime } from "../pathfinding/safetyEvaluator.js"
import { findAdvancedEscapePath, detectBombChains } from "./advancedEscape.js"

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

  // Check for bomb chains first
  if (bombs.length >= 3) {
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

  // Use standard shortest path escape
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

  // First pass: time-safe tiles
  for (const [dx, dy, dir] of DIRS) {
    const nx = player.x + dx
    const ny = player.y + dy

    if (!isWalkable(nx, ny, map)) continue

    const key = posKey(nx, ny)
    const isBombTile = bombs.some((bomb) => {
      const { x, y } = toGridCoords(bomb.x, bomb.y)
      return x === nx && y === ny
    })

    const willBeSafe = isTileSafeByTime(nx, ny, 1, bombs, bombers, map, currentSpeed)

    if (willBeSafe && !isBombTile) {
      console.log(`   ✅ Time-safe emergency move: ${dir} to [${nx}, ${ny}]`)
      console.log("🎯 DECISION: EMERGENCY ESCAPE (time-safe tile)")
      console.log("   Action:", dir)
      console.log("=".repeat(90) + "\n")

      return { action: dir }
    }
  }

  // Second pass: currently safe tiles
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
      console.log(
        `   ⚠️ Currently safe emergency move: ${dir} to [${nx}, ${ny}] (but bomb may explode!)`,
      )
      console.log("🎯 DECISION: EMERGENCY ESCAPE (currently safe)")
      console.log("   Action:", dir)
      console.log("=".repeat(90) + "\n")

      return { action: dir }
    }
  }

  // Third pass: any walkable tile
  for (const [dx, dy, dir] of DIRS) {
    const nx = player.x + dx
    const ny = player.y + dy

    if (!isWalkable(nx, ny, map)) continue

    const isBombTile = bombs.some((bomb) => {
      const { x, y } = toGridCoords(bomb.x, bomb.y)
      return x === nx && y === ny
    })

    if (!isBombTile) {
      console.log(`   ⚠️ Last resort move: ${dir} to [${nx}, ${ny}] (still in danger!)`)
      console.log("🎯 DECISION: EMERGENCY ESCAPE (desperate)")
      console.log("   Action:", dir)
      console.log("=".repeat(90) + "\n")

      return { action: dir }
    }
  }

  return null
}

/**
 * Check if player is currently safe from bombs
 */
export function checkSafety(map, player, bombs, bombers, myBomber) {
  const safeTiles = findSafeTiles(map, bombs, bombers, myBomber)
  const isPlayerSafe = bombs.length
    ? safeTiles.some((tile) => tile.x === player.x && tile.y === player.y)
    : true

  console.log(`   Safety Status: ${isPlayerSafe ? "✅ SAFE" : "🚨 DANGER"}`)
  console.log(`   Safe Tiles Available: ${safeTiles.length}`)

  return { isPlayerSafe, safeTiles }
}
