import {
  DIRS,
  WALKABLE,
  BREAKABLE,
  ITEMS,
  ITEM_PRIORITY_BIAS,
  OSCILLATION_THRESHOLD,
} from "../utils/constants.js"
import {
  posKey,
  isAdjacent,
  inBounds,
  toGridCoords,
  toBombGridCoords,
  manhattanDistance,
} from "../utils/gridUtils.js"
import { getBombWithGrid, getTimeUntilExplosion } from "../utils/bombUtils.js"
import { canPlaceBomb, getRemainingBombs } from "../utils/bomberUtils.js"
import { findBestPath, findSafePath, findShortestEscapePath } from "./pathfinding/index.js"
import { findSafeTiles, findUnsafeTiles } from "./pathfinding/dangerMap.js"
import { findEscapeAction, checkSafety } from "./strategy/unifiedEscape.js"
import {
  findAllItems,
  findAllChests,
  findAllEnemies,
  checkBombWouldDestroyItems,
  countChestsDestroyedByBomb,
  dynamicItemPriority,
  calculateRiskTolerance,
  determineGamePhase,
  findChainReactionOpportunities,
  isChainReactionWorthwhile,
  shouldFightOrFlee,
  validateBombSafety,
  compareSingleVsMultiTarget,
  decideEnemyBombing,
} from "./strategy/index.js"
import { createFutureBomb } from "../utils/bombUtils.js"

// Anti-oscillation: Track last position and decision
let lastPosition = null
let lastDecision = null
let decisionCount = 0
let isFollowingPath = false // Track if we're following a multi-step path
let lastEscapeFromPosition = null // Track position we just escaped from
let lastEscapeTime = 0
const ESCAPE_COOLDOWN_MS = 5000 // Don't return to escaped position for 5 seconds

// Spam bombing: Track ongoing spam sequence
let activeSpamSequence = null // { positions: [], target: {x, y}, targetEnemy: {id, x, y}, strategy: string, currentIndex: 0 }
let lastSpamBombTime = 0
const SPAM_BOMB_COOLDOWN_MS = 300 // Minimum 300ms between spam bombs (safety buffer)
const SPAM_TARGET_MAX_DISTANCE = 5 // Cancel spam if enemy moves >5 tiles away

// Track recently visited positions to prevent ping-pong between adjacent tiles
let recentPositions = [] // Array of {x, y, time}
const POSITION_MEMORY_MS = 3000 // Remember positions for 3 seconds
const MAX_POSITION_MEMORY = 5 // Remember last 5 positions

function trackDecision(player, action) {
  const key = posKey(player.x, player.y)
  lastPosition = key
  lastDecision = action

  // Track position in memory to prevent ping-pong
  const now = Date.now()
  recentPositions.push({ x: player.x, y: player.y, time: now })

  // Keep only recent positions (last 3 seconds)
  recentPositions = recentPositions.filter((p) => now - p.time < POSITION_MEMORY_MS)

  // Limit to last N positions
  if (recentPositions.length > MAX_POSITION_MEMORY) {
    recentPositions.shift()
  }
}

function isRecentlyVisited(x, y) {
  const now = Date.now()
  // Clean up old positions
  recentPositions = recentPositions.filter((p) => now - p.time < POSITION_MEMORY_MS)

  // Check if this position was visited recently
  return recentPositions.some((p) => p.x === x && p.y === y)
}

function trackEscape(fromX, fromY) {
  lastEscapeFromPosition = posKey(fromX, fromY)
  lastEscapeTime = Date.now()
  console.log(
    `   📌 Tracking escape from [${fromX}, ${fromY}] - won't return for ${ESCAPE_COOLDOWN_MS}ms`,
  )
}

function isRecentEscapePosition(x, y) {
  if (!lastEscapeFromPosition) return false
  const now = Date.now()
  const timeSinceEscape = now - lastEscapeTime
  if (timeSinceEscape > ESCAPE_COOLDOWN_MS) {
    // Cooldown expired
    return false
  }
  const positionKey = posKey(x, y)
  return positionKey === lastEscapeFromPosition
}

// Prevent immediate backtracking: if action would move back to lastPosition,
// try to pick an alternative walkable direction. Returns a direction string or "STAY".
// CRITICAL: Never select a direction that leads into danger!
function applyBacktrackGuard(action, player, map, bombs, bombers) {
  const dirsToNames = { LEFT: [-1, 0], RIGHT: [1, 0], UP: [0, -1], DOWN: [0, 1] }
  if (!action || !dirsToNames[action]) return action

  // Don't apply backtrack guard when following a planned path
  if (isFollowingPath) {
    console.log(`   ⏭️ Following planned path, skipping backtrack guard`)
    return action
  }

  if (!lastPosition) return action

  const [dx, dy] = dirsToNames[action]
  const tx = player.x + dx
  const ty = player.y + dy
  if (posKey(tx, ty) !== lastPosition) return action

  // Get unsafe tiles to avoid bomb zones
  const unsafeTiles = findUnsafeTiles(map, bombs, bombers)

  // This action would backtrack. Try alternatives (prefer same priority order)
  for (const dir of ["UP", "RIGHT", "DOWN", "LEFT"]) {
    if (dir === action) continue
    const [adx, ady] = dirsToNames[dir]
    const nx = player.x + adx
    const ny = player.y + ady

    // bounds and walkable check
    if (!inBounds(nx, ny)) continue
    if (!WALKABLE.includes(map[ny][nx])) continue

    // CRITICAL: Check if this direction leads into danger
    if (unsafeTiles.has(posKey(nx, ny))) {
      console.log(`   ⚠️ Backtrack guard: ${dir} leads to unsafe tile [${nx},${ny}] - skipping`)
      continue
    }

    // ensure no active bomb occupying the tile (unless walkable bomb flag true)
    const hasBomb = bombs.some((b) => {
      const { gridX, gridY } = getBombWithGrid(b)
      return gridX === nx && gridY === ny && !b.walkable
    })
    if (hasBomb) continue

    // avoid moving back to lastPosition
    if (posKey(nx, ny) === lastPosition) continue

    console.log(`   ✅ Backtrack guard: Found safe alternative ${dir} to [${nx},${ny}]`)
    return dir
  }

  console.log(`   ⚠️ Backtrack guard: No safe alternatives found`)
  return "STAY"
}

/**
 * Handle movement/bombing when a target is found
 */
function handleTarget(result, state, myUid) {
  const { map, bombs = [], bombers } = state
  const myBomber = bombers && bombers.find((b) => b.uid === myUid)
  const player = toGridCoords(myBomber.x, myBomber.y)

  console.log(`   Path: ${result.path.join(" → ")} (${result?.path?.length} steps)`)
  console.log(`   Walls blocking: ${result?.walls?.length}`)

  // If path is blocked by a chest, handle it
  if (result?.walls?.length > 0) {
    const targetWall = result.walls[0]
    console.log(`   First blocking wall at: [${targetWall.x}, ${targetWall.y}]`)

    if (isAdjacent(targetWall.x, targetWall.y, player.x, player.y)) {
      console.log("   🧱 Chest is adjacent! Considering bombing...")

      // CRITICAL: Use server's bomb placement logic to predict where bomb will be placed
      const bombPos = toBombGridCoords(myBomber.x, myBomber.y)
      console.log(
        `   📍 Bot at grid [${player.x}, ${player.y}], bomb will be placed at [${bombPos.x}, ${bombPos.y}]`,
      )

      // Check if bombing would destroy valuable items (using bomb position)
      const itemCheck = checkBombWouldDestroyItems(
        bombPos.x,
        bombPos.y,
        map,
        myBomber.explosionRange,
      )
      if (itemCheck.willDestroyItems) {
        console.log(
          `   ⚠️ Bombing would destroy ${itemCheck.items.length} item(s):`,
          itemCheck.items.map((i) => `${i.type} at [${i.x},${i.y}]`).join(", "),
        )
        console.log("   🎯 DECISION: STAY (Avoiding item destruction)")
        console.log("=".repeat(60) + "\n")
        return { action: "STAY" }
      }

      // Check chests that would be destroyed by bomb (using bomb position)
      const chestCount = countChestsDestroyedByBomb(
        bombPos.x,
        bombPos.y,
        map,
        myBomber.explosionRange,
      )
      console.log(
        `   💣 Bomb would destroy ${chestCount.count} chest(s):`,
        chestCount.chests.map((c) => `[${c.x},${c.y}]`).join(", "),
      )

      // CRITICAL SAFETY CHECK: Validate bomb safety BEFORE placing
      const validation = validateBombSafety(bombPos, map, bombs, bombers, myBomber, myUid)

      if (!validation.canBomb) {
        console.log(
          `   ❌ BOMB VALIDATION FAILED: ${validation.reason} - REFUSING TO BOMB (suicide prevention)`,
        )
        if (validation.escapeTime && validation.availableTime) {
          console.log(
            `      Need ${validation.escapeTime.toFixed(0)}ms but only ${validation.availableTime.toFixed(0)}ms available`,
          )
        }
        // Continue to next phase instead of bombing
        console.log("=".repeat(60) + "\n")
      } else {
        console.log(
          `   ✅ BOMB VALIDATED: Safe to bomb with escape path: ${validation.escapePath.join(" → ")}`,
        )
        console.log(
          `🎯 DECISION: BOMB + ESCAPE (${chestCount.count} blocking chest${chestCount.count > 1 ? "s" : ""})`,
        )
        console.log(
          "   💣 Bombing from",
          `[${player.x}, ${player.y}], bomb at [${bombPos.x}, ${bombPos.y}]`,
        )
        console.log("   🏃 Escape action:", validation.escapeAction)
        console.log("=".repeat(60) + "\n")
        if (canPlaceBomb(myBomber, bombs, myUid)) {
          return {
            action: "BOMB",
            escapeAction: validation.escapeAction,
            isEscape: true,
            fullPath: validation.escapePath,
            fullPathCoordinates: validation.escapeCoordinates || [],
          }
        }
      }
    } else {
      console.log(`   Wall not adjacent, need to move closer first`)
    }
    // If we didn't bomb, continue to other logic below
  } else {
    // No walls blocking path
  }

  // Move towards target
  if (result.path.length > 0) {
    // CRITICAL SAFETY CHECK: Validate destination is NOT in imminent danger
    // Calculate destination position
    let destX = player.x
    let destY = player.y
    const firstMove = result.path[0]

    if (firstMove === "UP") destY--
    else if (firstMove === "DOWN") destY++
    else if (firstMove === "LEFT") destX--
    else if (firstMove === "RIGHT") destX++

    // Check if destination is in blast zone of any IMMINENT bomb (< 1 second)
    const imminentBombs = bombs.filter((bomb) => {
      const now = Date.now()
      const timeUntilExplosion = Math.max(0, bomb.lifeTime - (now - bomb.createdAt))
      return timeUntilExplosion < 1000 // Less than 1 second
    })

    if (imminentBombs.length > 0) {
      const unsafeTiles = findUnsafeTiles(map, imminentBombs, bombers)
      const destKey = `${destX},${destY}`

      if (unsafeTiles.has(destKey)) {
        console.log(
          `   ⚠️ SAFETY OVERRIDE: Destination [${destX},${destY}] is in blast zone of imminent bomb!`,
        )
        imminentBombs.forEach((b) => {
          const { gridX, gridY } = getBombWithGrid(b)
          const timeLeft = getTimeUntilExplosion(b)
          console.log(`      💣 Bomb at [${gridX},${gridY}] explodes in ${timeLeft.toFixed(0)}ms`)
        })
        console.log(`   🚫 REFUSING dangerous move - will explore instead`)
        console.log("=".repeat(60) + "\n")
        // Don't return - let it fall through to exploration phase
        return null
      }
    }

    console.log("🎯 DECISION: MOVE (towards target)")
    console.log("   Action:", result.path[0])
    console.log("=".repeat(60) + "\n")
    trackDecision(player, result.path[0])
    // Return the full path so the client can follow the entire route and avoid local oscillation
    return {
      action: result.path[0],
      fullPath: result.path,
      fullPathCoordinates: result.fullPathCoordinates || [],
    }
  }

  // SPECIAL CASE: Already at target bombing position (path.length === 0, no walls blocking)
  // This happens when player is at an optimal chest bombing position OR at an item position
  if (result.path.length === 0 && result.walls.length === 0) {
    console.log("   💡 Already at target position!")

    // PRIORITY: Check if we're standing on an item tile
    const currentTile = map[player.y] && map[player.y][player.x]
    const isOnItemTile = ITEMS.includes(currentTile)

    if (isOnItemTile) {
      // Standing on item - move away to collect, don't try to bomb
      console.log(`   📦 Standing on item tile (${currentTile}), moving away to collect`)

      // Try to find a walkable adjacent tile
      for (const [dx, dy, dir] of DIRS) {
        const nx = player.x + dx
        const ny = player.y + dy

        if (inBounds(nx, ny) && WALKABLE.includes(map[ny][nx])) {
          const hasBomb = bombs.some((b) => {
            const { gridX, gridY } = getBombWithGrid(b)
            return gridX === nx && gridY === ny && !b.walkable
          })

          if (!hasBomb) {
            console.log(`   ➡️ Moving ${dir} to collect item`)
            console.log("🎯 DECISION: MOVE (collect item)")
            console.log("=".repeat(60) + "\n")
            trackDecision(player, dir)
            return { action: dir }
          }
        }
      }

      console.log("   ⚠️ No walkable adjacent tiles, staying")
      console.log("🎯 DECISION: STAY (No escape from item)")
      console.log("=".repeat(60) + "\n")
      return { action: "STAY" }
    }

    // CRITICAL: Use server's bomb placement logic to predict where bomb will be placed
    const bombPos = toBombGridCoords(myBomber.x, myBomber.y)
    console.log(
      `   📍 Bot at grid [${player.x}, ${player.y}], bomb will be placed at [${bombPos.x}, ${bombPos.y}]`,
    )

    // Check if there are chests adjacent to bomb position (not player position!)
    const chestCount = countChestsDestroyedByBomb(
      bombPos.x,
      bombPos.y,
      map,
      myBomber.explosionRange,
    )

    if (canPlaceBomb(myBomber, bombs, myUid)) {
      console.log(
        `   💣 Can destroy ${chestCount.count} chest(s):`,
        chestCount.chests.map((c) => `[${c.x},${c.y}]`).join(", "),
      )

      // Check if bombing would destroy items (using bomb position)
      const itemCheck = checkBombWouldDestroyItems(
        bombPos.x,
        bombPos.y,
        map,
        myBomber.explosionRange,
      )
      if (itemCheck.willDestroyItems) {
        console.log(`   ⚠️ Would destroy ${itemCheck.items.length} item(s), skipping bomb`)
        console.log(`   🚶 Moving away to avoid destroying items`)

        // Don't stay here - return null to let main function continue to PHASE 6
        console.log("🎯 DECISION: (Will explore instead of staying)")
        console.log("=".repeat(60) + "\n")
        return null // Signal to continue to exploration phase
      } else {
        // Only proceed with bombing if we won't destroy items

        // Validate escape path (using bomb position)
        const futureBombs = [
          ...bombs,
          createFutureBomb(bombPos.x, bombPos.y, myBomber.explosionRange, myBomber.uid),
        ]
        const futureSafeTiles = findSafeTiles(map, futureBombs, bombers, myBomber)

        if (futureSafeTiles.length > 0) {
          // CRITICAL: Escape path must start from PLAYER's CURRENT position
          // Bot hasn't moved yet, so escape from where bot is NOW, not where bomb will be
          const escapeStartPos = { x: player.x, y: player.y }

          // CRITICAL: Use findShortestEscapePath instead of findBestPath
          // This ensures the escape destination has valid exits (not deadlocked by walls/chests)
          const escapePath = findShortestEscapePath(
            map,
            escapeStartPos, // Start from CURRENT player position!
            futureBombs,
            bombers,
            myBomber,
            false, // strictMode = false (allow timing-based escapes)
          )

          if (escapePath && escapePath.path.length > 0) {
            // Escape path already validated by findShortestEscapePath (has valid exits)
            const destX = escapePath.target.x
            const destY = escapePath.target.y

            // CRITICAL: Validate that from escape destination, bot can reach COMPLETE SAFETY
            // (not just escape immediate bomb, but also avoid being trapped by other bombs)
            // NOTE: escapePath.target is already in grid coordinates, use it directly
            const escapeDestPos = {
              x: destX,
              y: destY,
            }
            const secondEscapePath = findShortestEscapePath(
              map,
              escapeDestPos,
              futureBombs,
              bombers,
              myBomber,
              false,
            )

            if (!secondEscapePath) {
              console.log(
                `   ⚠️ Escape destination [${destX}, ${destY}] leads to DEADLOCK - cannot bomb safely`,
              )
              console.log(`      (Can escape immediate bomb, but will be trapped by other bombs)`)
            } else {
              console.log(
                `   ✅ Canz escape: ${escapePath.path.join(" → ")} to [${destX}, ${destY}]`,
              )
              console.log(
                `🎯 DECISION: BOMB + ESCAPE (${chestCount.count} chest${chestCount.count > 1 ? "s" : ""})`,
              )
              console.log(
                "   💣 Bombing from grid position",
                `[${player.x}, ${player.y}], bomb at [${bombPos.x}, ${bombPos.y}]`,
              )
              console.log("   🏃 Escape action:", escapePath.path[0])
              console.log("=".repeat(60) + "\n")

              return {
                action: "BOMB",
                escapeAction: escapePath.path[0],
                isEscape: true,
                fullPath: escapePath.path,
                fullPathCoordinates: escapePath.fullPathCoordinates || [],
              }
            }
          } else {
            console.log(`   ❌ No escape path, cannot bomb safely`)
          }
        } else {
          console.log(`   ❌ No safe tiles after bombing`)
        }
      } // End of else block - only bomb if won't destroy items
    }
    // If we reach here, no valid bomb action found at this position
    // Return null to let main function continue to exploration
  }

  console.log("   ℹ️ No valid bomb action at current position")
  console.log("=".repeat(60) + "\n")
  // Don't STAY - return null to continue to exploration phase
  return null
}

/**
 * Main decision function - entry point
 */
export function decideNextAction(state, myUid) {
  const { map, bombs = [], bombers } = state
  const myBomber = bombers && bombers.find((b) => b.uid === myUid)

  if (!myBomber || !myBomber.isAlive) {
    console.warn("⚠️ No active bomber found for UID:", myUid)
    return { action: "STAY" }
  }

  const player = toGridCoords(myBomber.x, myBomber.y)

  // Track current position in history BEFORE making decision
  const now = Date.now()
  recentPositions.push({ x: player.x, y: player.y, time: now })
  // Keep only recent positions (last 3 seconds) and limit to 5
  recentPositions = recentPositions.filter((p) => now - p.time < POSITION_MEMORY_MS)
  if (recentPositions.length > MAX_POSITION_MEMORY) {
    recentPositions.shift()
  }

  // Reset following path flag when new decision is needed
  // This prevents backtrack guard from blocking valid paths
  isFollowingPath = false

  // Detect ping-pong pattern using position history: [A,B,A,B]
  if (recentPositions.length >= 4) {
    const recent4 = recentPositions.slice(-4)
    const pos0 = posKey(recent4[0].x, recent4[0].y)
    const pos1 = posKey(recent4[1].x, recent4[1].y)
    const pos2 = posKey(recent4[2].x, recent4[2].y)
    const pos3 = posKey(recent4[3].x, recent4[3].y)

    // Pattern: A→B→A→B (oscillating between 2 positions)
    if (pos0 === pos2 && pos1 === pos3 && pos0 !== pos1) {
      console.log(`⚠️ Detected ping-pong (A↔B) pattern: [${pos0}] ↔ [${pos1}]`)
      console.log(`   Breaking oscillation - staying put to force re-evaluation`)
      // Clear history to prevent continuous trigger
      recentPositions = []
      return { action: "STAY" }
    }
  }

  // Anti-oscillation check
  const currentPosKey = posKey(player.x, player.y)
  if (lastPosition === currentPosKey && lastDecision) {
    decisionCount++
    if (decisionCount >= OSCILLATION_THRESHOLD) {
      console.log(
        `⚠️ OSCILLATION detected at [${player.x}, ${player.y}] - trying alternative action`,
      )

      // CRITICAL: Don't commit to same action that caused oscillation!
      // Try to find a different walkable direction
      const unsafeTiles = findUnsafeTiles(map, bombs, bombers)

      for (const [dx, dy, dir] of DIRS) {
        // Skip the action that caused oscillation
        if (dir === lastDecision) continue

        const nx = player.x + dx
        const ny = player.y + dy

        // Check if walkable and safe
        if (inBounds(nx, ny) && WALKABLE.includes(map[ny][nx])) {
          const posKey = `${nx},${ny}`
          if (!unsafeTiles.has(posKey)) {
            // Check for bombs
            const hasBomb = bombs.some((b) => {
              const { gridX, gridY } = getBombWithGrid(b)
              return gridX === nx && gridY === ny
            })

            if (!hasBomb) {
              console.log(`   ✅ Breaking oscillation with alternative: ${dir} to [${nx}, ${ny}]`)
              lastPosition = null
              decisionCount = 0
              trackDecision(player, dir)
              return { action: dir }
            }
          }
        }
      }

      // No alternative found - reset oscillation state and STAY
      console.log(`   ⚠️ No safe alternatives found - resetting oscillation state and STAYING`)
      lastPosition = null
      lastDecision = null
      decisionCount = 0
      trackDecision(player, "STAY")
      return { action: "STAY" }
    }
  } else {
    decisionCount = 0
  }

  console.log("💣 Active (non-exploded) Bombs:", bombs.length)
  if (bombs.length > 0) {
    console.log("   Bomb positions:")
    bombs.forEach((b, i) => {
      const { gridX, gridY } = getBombWithGrid(b)
      console.log(
        `   Bomb ${i + 1}: [${gridX}, ${gridY}] | owner: ${b.uid === myUid ? "ME" : b.uid}`,
      )
    })
  }

  // Show bomb capacity info
  const myActiveBombs = bombs.filter((b) => b.uid === myUid).length
  const remainingBombs = getRemainingBombs(myBomber, bombs, myUid)
  console.log(
    `💣 My Bombs: ${myActiveBombs}/${myBomber.bombCount} active | ${remainingBombs} remaining to place`,
  )
  // console.log("👥 Active Bombers:", bombers.filter((b) => b.isAlive).length)

  // PHASE 0: Game Context Analysis
  console.log("\n🔍 PHASE 0: Game Context Analysis")
  const enemies = findAllEnemies(bombers, myUid)
  const allItems = findAllItems(map, bombs, bombers, false)
  const allChests = findAllChests(map, bombs, bombers, false)

  const gamePhase = determineGamePhase(myBomber, enemies, allItems, allChests)
  const riskTolerance = calculateRiskTolerance(myBomber, enemies, allItems, allChests)
  const fightOrFlee = shouldFightOrFlee(enemies, myBomber, player, {
    itemCount: allItems.length,
    chestCount: allChests.length,
  })

  console.log(`   Game Phase: ${gamePhase.toUpperCase()}`)
  console.log(`   Risk Tolerance: ${(riskTolerance * 100).toFixed(0)}%`)
  console.log(`   Strategy: ${fightOrFlee.toUpperCase()}`)
  console.log(
    `   Enemies: ${enemies.length} | Items: ${allItems.length} | Chests: ${allChests.length}`,
  )

  // PHASE 1: Safety Check
  console.log("\n🔍 PHASE 1: Safety Check")
  const { isPlayerSafe, safeTiles } = checkSafety(map, player, bombs, bombers, myBomber)

  if (!isPlayerSafe) {
    // Use unified escape system
    const escapeResult = findEscapeAction(map, player, bombs, bombers, myUid)
    if (escapeResult) {
      trackDecision(player, escapeResult.action)
      trackEscape(player.x, player.y) // Track that we're escaping from this position
      return escapeResult
    }

    console.log("   ❌ No escape possible! Bracing for impact.")
    console.log("🎯 DECISION: STAY (No escape)")
    console.log("=".repeat(90) + "\n")
    trackDecision(player, "STAY")
    return { action: "STAY" }
  }

  // PHASE 1.5: Enemy Trap Detection (if aggressive) (REFACTORED)
  if (fightOrFlee === "fight" && enemies.length > 0 && canPlaceBomb(myBomber, bombs, myUid)) {
    console.log("\n🔍 PHASE 1.5: Enemy Trap Detection")

    // Use unified enemy bombing system for trap detection
    const trapResult = decideEnemyBombing({
      mode: "trap",
      enemies,
      player,
      myBomber,
      map,
      bombs,
      bombers,
      myUid,
      trackDecision,
      riskTolerance,
    })

    if (trapResult) {
      return trapResult
    }
  }

  // PHASE 1.6: Chain Reaction Detection
  if (bombs.length > 0 && canPlaceBomb(myBomber, bombs, myUid) && riskTolerance > 0.5) {
    console.log("\n🔍 PHASE 1.6: Chain Reaction Detection")
    const chainOpportunities = findChainReactionOpportunities(
      player,
      map,
      bombs,
      bombers,
      myBomber,
      5,
    )

    if (chainOpportunities.length > 0) {
      const bestChain = chainOpportunities[0]
      console.log(`   💥 CHAIN REACTION POSSIBLE! Triggers: ${bestChain.triggeredBombs} bombs`)
      console.log(
        `   Chests: ${bestChain.chestsDestroyed} | Total Destruction: ${bestChain.totalDestruction}`,
      )

      if (isChainReactionWorthwhile(bestChain, riskTolerance)) {
        const validation = validateBombSafety(bestChain, map, bombs, bombers, myBomber, myUid)

        if (validation.canBomb && bestChain.distance === 0) {
          console.log(`   🔥 Triggering chain reaction!`)
          console.log(`🎯 DECISION: BOMB (Chain Reaction)`)
          console.log("=".repeat(90) + "\n")
          trackDecision(player, "BOMB")
          return {
            action: "BOMB",
            isEscape: true,
            escapeAction: validation.escapeAction,
            fullPath: validation.escapePath,
          }
        }
      }
    }
  }

  // PHASE 1.6.5: Check for active spam sequence continuation
  // If bot just escaped from spam bombing, try to continue spamming
  if (activeSpamSequence && canPlaceBomb(myBomber, bombs, myUid)) {
    const now = Date.now()
    const timeSinceLastBomb = now - lastSpamBombTime

    console.log("\n🔍 PHASE 1.6.5: Spam Sequence Continuation Check")
    console.log(`   Active spam: ${activeSpamSequence.strategy}`)
    console.log(
      `   Current index: ${activeSpamSequence.currentIndex}/${activeSpamSequence.positions.length}`,
    )
    console.log(`   Time since last bomb: ${timeSinceLastBomb}ms`)
    console.log(`   Remaining bombs: ${getRemainingBombs(myBomber, bombs, myUid)}`)

    // Check if target enemy still exists and hasn't moved too far
    if (activeSpamSequence.targetEnemy) {
      const currentEnemy = enemies.find((e) => e.id === activeSpamSequence.targetEnemy.id)

      if (!currentEnemy) {
        console.log(`   ❌ Target enemy (ID: ${activeSpamSequence.targetEnemy.id}) is dead/gone`)
        console.log(`   🚫 CANCELLING spam sequence`)
        activeSpamSequence = null
        // Continue to next phase
      } else {
        // Check if enemy moved too far from original position
        const enemyMovedDistance = manhattanDistance(
          currentEnemy.x,
          currentEnemy.y,
          activeSpamSequence.targetEnemy.x,
          activeSpamSequence.targetEnemy.y,
        )

        if (enemyMovedDistance > SPAM_TARGET_MAX_DISTANCE) {
          console.log(
            `   ❌ Target enemy moved ${enemyMovedDistance} tiles away from spam zone (max: ${SPAM_TARGET_MAX_DISTANCE})`,
          )
          console.log(
            `      Original: [${activeSpamSequence.targetEnemy.x},${activeSpamSequence.targetEnemy.y}]`,
          )
          console.log(`      Current:  [${currentEnemy.x},${currentEnemy.y}]`)
          console.log(`   🚫 CANCELLING spam sequence - target escaped`)
          activeSpamSequence = null
          // Continue to next phase
        } else {
          console.log(`   ✅ Target enemy still in range (moved ${enemyMovedDistance} tiles)`)
        }
      }
    }

    // Check if spam sequence is still valid
    if (activeSpamSequence && timeSinceLastBomb >= SPAM_BOMB_COOLDOWN_MS) {
      const nextIndex = activeSpamSequence.currentIndex + 1

      if (nextIndex < activeSpamSequence.positions.length) {
        const nextPos = activeSpamSequence.positions[nextIndex]
        console.log(`   📍 Next spam position: [${nextPos.x},${nextPos.y}]`)

        // Move to next spam position
        // SPAM MOVEMENT: Use timing-based crossing for aggressive movement!
        const pathToNext = findBestPath(
          map,
          player,
          [nextPos],
          bombs,
          bombers,
          myUid,
          false, // not escaping
          true, // allowTimingCrossing - AGGRESSIVE for spam!
        )

        if (pathToNext && pathToNext.path.length > 0) {
          // If already at position, BOMB immediately
          if (player.x === nextPos.x && player.y === nextPos.y) {
            console.log(`   💣 CONTINUE SPAM! Bombing at [${nextPos.x},${nextPos.y}]`)

            // Validate escape path
            // SPAM BOMBING: Use aggressive escape (allowTimingCrossing = true)
            // Spam is high-risk strategy - need to take calculated risks!
            const futureBombs = [
              ...bombs,
              createFutureBomb(nextPos.x, nextPos.y, myBomber.explosionRange, myBomber.uid),
            ]
            const futureSafeTiles = findSafeTiles(map, futureBombs, bombers, myBomber)
            const escapePath = findBestPath(
              map,
              nextPos,
              futureSafeTiles,
              futureBombs,
              bombers,
              myUid,
              true, // isEscaping
              true, // allowTimingCrossing - AGGRESSIVE for spam!
            )

            if (escapePath && escapePath.path.length > 0) {
              // Update spam state
              activeSpamSequence.currentIndex = nextIndex
              lastSpamBombTime = now

              console.log(
                `🎯 DECISION: BOMB (Spam Continuation ${nextIndex + 1}/${activeSpamSequence.positions.length})`,
              )
              console.log("=".repeat(90) + "\n")
              trackDecision(player, "BOMB")

              return {
                action: "BOMB",
                isEscape: true,
                escapeAction: escapePath.path[0],
                fullPath: escapePath.path,
                mode: `spam_${activeSpamSequence.strategy}_continue`,
              }
            } else {
              console.log(`   ❌ No escape path from next spam position - ending spam sequence`)
              activeSpamSequence = null
            }
          } else {
            // Move toward spam position
            console.log(`   🚶 Moving to spam position: ${pathToNext.path[0]}`)
            console.log(`🎯 DECISION: MOVE (Spam Continuation)`)
            console.log("=".repeat(90) + "\n")
            trackDecision(player, pathToNext.path[0])

            return {
              action: pathToNext.path[0],
              mode: `spam_${activeSpamSequence.strategy}_move`,
            }
          }
        } else {
          console.log(`   ❌ No path to next spam position - ending spam sequence`)
          activeSpamSequence = null
        }
      } else {
        console.log(
          `   ✅ Spam sequence completed! (${activeSpamSequence.positions.length} bombs placed)`,
        )
        activeSpamSequence = null
      }
    } else {
      console.log(
        `   ⏳ Spam cooldown active (${SPAM_BOMB_COOLDOWN_MS - timeSinceLastBomb}ms remaining)`,
      )
    }
  }

  // PHASE 1.7: Advanced Combat (HIGHEST PRIORITY - Smart Predictive Bombing)
  // NEW: Use advanced combat strategies (predictive, blocking, range bombing)
  if (fightOrFlee === "fight" && enemies.length > 0 && canPlaceBomb(myBomber, bombs, myUid)) {
    console.log("\n🔍 PHASE 1.7: Advanced Combat (Smart Strategies)")

    // Try advanced combat first (predictive & blocking)
    const advancedCombatResult = decideEnemyBombing({
      mode: "advanced_combat",
      enemies,
      player,
      myBomber,
      map,
      bombs,
      bombers,
      myUid,
      trackDecision,
    })

    if (advancedCombatResult) {
      // CRITICAL: Initialize spam sequence if this is a spam bombing decision
      if (
        advancedCombatResult.mode &&
        advancedCombatResult.mode.startsWith("spam_") &&
        advancedCombatResult.spamSequence
      ) {
        console.log(`   🎯 INITIALIZING SPAM SEQUENCE!`)
        console.log(`      Positions: ${advancedCombatResult.spamSequence.length}`)
        console.log(
          `      Target: [${advancedCombatResult.spamTarget.x},${advancedCombatResult.spamTarget.y}]`,
        )
        console.log(`      Target Enemy ID: ${advancedCombatResult.targetEnemy?.id || "unknown"}`)

        // Find the target enemy object to lock onto
        const targetEnemy = enemies.find(
          (e) =>
            e.x === advancedCombatResult.spamTarget.x && e.y === advancedCombatResult.spamTarget.y,
        )

        activeSpamSequence = {
          positions: advancedCombatResult.spamSequence,
          target: advancedCombatResult.spamTarget,
          targetEnemy: targetEnemy
            ? { id: targetEnemy.id, x: targetEnemy.x, y: targetEnemy.y }
            : null,
          strategy: advancedCombatResult.mode.replace("spam_", ""),
          currentIndex: 0, // Start at first position
        }
        lastSpamBombTime = Date.now()
      }

      return advancedCombatResult
    }

    // Fallback to priority pursuit (adjacent bombing)
    const priorityPursuitResult = decideEnemyBombing({
      mode: "priority_pursuit",
      enemies,
      player,
      myBomber,
      map,
      bombs,
      bombers,
      myUid,
      trackDecision,
      maxDistance: 12, // ULTRA AGGRESSIVE: Pursue enemies within 12 tiles
    })

    if (priorityPursuitResult) {
      return priorityPursuitResult
    }

    console.log(`   ℹ️ No combat opportunities found`)
  }

  // PHASE 2: Dynamic Item Prioritization
  // EARLY game with many chests: Only collect NEARBY items (≤5 steps), skip far items
  // MID/LATE game: Collect all accessible items
  console.log(`\n🔍 PHASE 2: Dynamic Item Prioritization`)
  const items = findAllItems(map, bombs, bombers, false)
  console.log(`   Items found: ${items.length}`)

  const isEarlyWithManyChests = gamePhase === "EARLY" && allChests.length > 5
  if (isEarlyWithManyChests) {
    console.log(`   📦 EARLY GAME: Will prioritize nearby items only (skip far items for chests)`)
  }

  let itemResult = null // Initialize outside block

  // CRITICAL: Classify items by danger level instead of filtering completely
  const unsafeTiles = findUnsafeTiles(map, bombs, bombers)
  const itemsWithDanger = items.map((item) => {
    const itemKey = posKey(item.x, item.y)
    const isInBlastZone = unsafeTiles.has(itemKey)

    // If item is in blast zone, calculate time until danger
    let timeUntilDanger = Infinity
    if (isInBlastZone) {
      for (const bomb of bombs) {
        const { gridX, gridY } = getBombWithGrid(bomb)
        const distance = Math.abs(item.x - gridX) + Math.abs(item.y - gridY)

        if (distance <= bomb.explosionRange) {
          const bombTimeRemaining = getTimeUntilExplosion(bomb)
          timeUntilDanger = Math.min(timeUntilDanger, bombTimeRemaining)
        }
      }
    }

    return {
      ...item,
      isInBlastZone,
      timeUntilDanger,
    }
  })

  // Filter out only items that are truly inaccessible or anti-oscillation
  const accessibleItems = itemsWithDanger.filter((item) => {
    // ANTI-OSCILLATION: Filter items at recently escaped position
    const isRecentEscape = isRecentEscapePosition(item.x, item.y)
    if (isRecentEscape) {
      console.log(
        `   🚫 Filtering out item at recent escape position: ${item.type} at [${item.x},${item.y}] (anti-oscillation)`,
      )
      return false
    }

    // ANTI-PING-PONG: Filter items at recently visited positions
    const wasRecentlyVisited = isRecentlyVisited(item.x, item.y)
    if (wasRecentlyVisited) {
      console.log(
        `   🔄 Filtering out item at recently visited position: ${item.type} at [${item.x},${item.y}] (anti-ping-pong)`,
      )
      return false
    }

    // Keep item for consideration (will check timing during pathfinding)
    return true
  })

  // Log dangerous items separately
  const dangerousItems = accessibleItems.filter((item) => item.isInBlastZone)
  if (dangerousItems.length > 0) {
    console.log(`   ⚠️ ${dangerousItems.length} item(s) in blast zones - will check timing:`)
    dangerousItems.forEach((item) => {
      console.log(
        `      ${item.type} at [${item.x},${item.y}] - ${(item.timeUntilDanger / 1000).toFixed(1)}s until explosion`,
      )
    })
  }

  if (accessibleItems.length < items.length) {
    console.log(
      `   🛡️ Filtered: ${items.length} total → ${accessibleItems.length} accessible items`,
    )
  }

  // Apply dynamic prioritization to accessible items
  // SCALE priority for items in blast zones based on available time
  const prioritizedItems = accessibleItems
    .map((item) => {
      const priorityData = dynamicItemPriority(item, myBomber, enemies, player, gamePhase)

      // CRITICAL: Scale value based on timing safety margin
      if (item.isInBlastZone && item.timeUntilDanger < Infinity) {
        const distance = Math.abs(item.x - player.x) + Math.abs(item.y - player.y)
        // ADJUSTED: Use actual measured timing (actual ~1.20x slower than theory)
        // Theory: (40px/speed) * 17ms = 680ms @ speed 1
        // Measured: Speed 1: 789ms → 1.16x | Speed 2: 407ms → 1.20x | Speed 3: 273ms → 1.20x (avg: 1.20x)
        const msPerGridTheory = (40 / myBomber.speed) * 17 // Using GRID_SIZE=40, STEP_DELAY=17
        const msPerGridActual = msPerGridTheory * 1.2 // Account for network/server/alignment delay (post queue optimization)
        const moveTime = distance * msPerGridActual
        const safetyBuffer = 400 // ms buffer (reduced since moveTime already adjusted)
        const requiredTime = moveTime + safetyBuffer
        const timingRatio = item.timeUntilDanger / requiredTime

        if (timingRatio > 1.5) {
          // Plenty of time: +50% bonus (high risk, high reward)
          priorityData.finalValue *= 1.5
          priorityData.riskBonus = "SAFE"
        } else if (timingRatio > 1.0) {
          // Just enough time: +20% bonus (calculated risk)
          priorityData.finalValue *= 1.2
          priorityData.riskBonus = "TIGHT"
        } else if (timingRatio > 0.8) {
          // Too tight: PENALTY -50% (discourage risky moves)
          priorityData.finalValue *= 0.5
          priorityData.riskBonus = "UNSAFE"
        } else {
          // Definitely unsafe: PENALTY -80% (strongly discourage)
          priorityData.finalValue *= 0.2
          priorityData.riskBonus = "DEADLY"
        }
      }

      return priorityData
    })
    .sort((a, b) => b.finalValue - a.finalValue)

  if (prioritizedItems.length > 0) {
    console.log(`   Top 3 prioritized items:`)
    prioritizedItems.slice(0, 3).forEach((pi, idx) => {
      const riskTag = pi.item.isInBlastZone ? ` 🔥 ${pi.riskBonus || "RISKY"}` : ""
      console.log(
        `     ${idx + 1}. ${pi.item.type} at [${pi.item.x},${pi.item.y}] - Value: ${pi.finalValue.toFixed(1)}${riskTag}`,
      )
    })
  }

  // Try multi-target path for items
  if (prioritizedItems.length > 0) {
    let topItems = prioritizedItems.slice(0, 5).map((pi) => pi.item)

    // EARLY game with many chests: Filter out far items (>5 steps)
    if (isEarlyWithManyChests) {
      const nearbyItems = topItems.filter((item) => {
        const distance = Math.abs(item.x - player.x) + Math.abs(item.y - player.y)
        return distance <= 5
      })

      if (nearbyItems.length < topItems.length) {
        console.log(
          `   🔍 EARLY: Filtered ${topItems.length - nearbyItems.length} far items (keeping ${nearbyItems.length} nearby)`,
        )
        topItems = nearbyItems
      }
    }

    const multiStrategy =
      topItems.length > 0
        ? compareSingleVsMultiTarget(player, topItems, map, bombs, bombers, myUid)
        : null

    if (multiStrategy) {
      if (multiStrategy.strategy === "multi") {
        console.log(
          `   ✅ Multi-target path: ${multiStrategy.path.targetCount} items, efficiency: ${multiStrategy.path.efficiency.toFixed(2)}`,
        )
        itemResult = {
          path: multiStrategy.path.totalPath,
          isMultiTarget: true,
          targets: multiStrategy.path.targetCount,
        }
      } else {
        console.log(`   ✅ Single-target path: ${multiStrategy.path.path.join(" → ")}`)
        itemResult = multiStrategy.path
      }
    }
  }

  if (itemResult) {
    console.log(
      `   ✅ Path to item(s): ${itemResult.path.slice(0, 5).join(" → ")} (${itemResult.path.length} steps)`,
    )
  } else if (items.length > 0) {
    console.log(`   ❌ No path to items found`)
  }

  // PHASE 3: Find Chests
  console.log(`\n🔍 PHASE 3: Chest Bombing`)
  const chests = findAllChests(map, bombs, bombers)
  console.log(`   Chests found: ${chests.length}`)
  if (chests.length > 0) {
    console.log(
      `   Chest locations:`,
      chests
        .slice(0, 3)
        .map((c) => `[${c.x},${c.y}]`)
        .join(", "),
    )
  }

  let chestResult = null
  if (chests.length) {
    // Check if within bomb range of a chest (not just adjacent)
    const nearbyChest = chests.find((chest) => {
      const distance = manhattanDistance(chest.x, chest.y, player.x, player.y)
      if (distance > myBomber.explosionRange) return false

      // Check if there's a clear line in any direction
      for (const [dx, dy] of DIRS) {
        let canHit = true
        for (let d = 1; d <= distance; d++) {
          const checkX = player.x + dx * d
          const checkY = player.y + dy * d
          if (checkX === chest.x && checkY === chest.y) {
            return true // Found the chest
          }
          if (!map[checkY] || !WALKABLE.includes(map[checkY][checkX])) {
            canHit = false
            break
          }
        }
      }
      return false
    })

    if (nearbyChest) {
      console.log(`\n🔍 PHASE 3: Within Range Chest Bombing`)

      // Verify chest still exists in map (not already destroyed)
      const chestCell = map[nearbyChest.y] && map[nearbyChest.y][nearbyChest.x]
      if (chestCell !== "C") {
        console.log(
          `   ⚠️ Nearby chest at [${nearbyChest.x}, ${nearbyChest.y}] already destroyed, skipping`,
        )
      } else {
        const distance = manhattanDistance(nearbyChest.x, nearbyChest.y, player.x, player.y)
        console.log(
          `   🧱 Chest at [${nearbyChest.x}, ${nearbyChest.y}] within range (${distance} tiles)`,
        )

        // CRITICAL: Use server's bomb placement logic
        const bombPos = toBombGridCoords(myBomber.x, myBomber.y)
        console.log(
          `   📍 Bot at grid [${player.x}, ${player.y}], bomb will be placed at [${bombPos.x}, ${bombPos.y}]`,
        )

        const bombAlreadyHere = bombs.some((bomb) => {
          const { gridX, gridY } = getBombWithGrid(bomb)
          return gridX === bombPos.x && gridY === bombPos.y
        })

        if (bombAlreadyHere) {
          console.log(
            `   ⏸️  Bomb already exists at [${bombPos.x}, ${bombPos.y}], escaping instead`,
          )
          const escapePath = findShortestEscapePath(map, player, bombs, bombers, myBomber)
          if (escapePath && escapePath.path.length > 0) {
            return {
              action: escapePath.path[0],
              isEscape: true,
              fullPath: escapePath.path,
              fullPathCoordinates: escapePath.fullPathCoordinates || [],
            }
          }
          return { action: "STAY" }
        }

        if (canPlaceBomb(myBomber, bombs, myUid)) {
          const itemCheck = checkBombWouldDestroyItems(
            bombPos.x,
            bombPos.y,
            map,
            myBomber.explosionRange,
          )
          if (itemCheck.willDestroyItems) {
            console.log(
              `   ⚠️ Bombing would destroy ${itemCheck.items.length} item(s):`,
              itemCheck.items.map((i) => `${i.type} at [${i.x},${i.y}]`).join(", "),
            )
            console.log(
              "   ⚠️ Skipping adjacent chest bomb (would destroy items, will prioritize item in Phase 4)",
            )
            // Don't return here - continue to Phase 4 where item will be prioritized
          } else {
            // Use validateBombSafety for comprehensive bomb validation
            const validation = validateBombSafety(bombPos, map, bombs, bombers, myBomber, myUid)

            if (validation.canBomb) {
              const chestCount = countChestsDestroyedByBomb(
                bombPos.x,
                bombPos.y,
                map,
                myBomber.explosionRange,
              )
              console.log(
                `   💣 Bomb would destroy ${chestCount.count} chest(s):`,
                chestCount.chests.map((c) => `[${c.x},${c.y}]`).join(", "),
              )
              console.log(`   ✅ Bomb safety validated: ${validation.reason}`)
              console.log(
                `🎯 DECISION: BOMB + ESCAPE (${chestCount.count} chest${chestCount.count > 1 ? "s" : ""})`,
              )
              console.log(
                "   💣 Bombing from grid",
                `[${player.x}, ${player.y}], bomb at [${bombPos.x}, ${bombPos.y}]`,
              )
              console.log("   🏃 Escape action:", validation.escapeAction)
              console.log("=".repeat(90) + "\n")

              return {
                action: "BOMB",
                isEscape: true,
                escapeAction: validation.escapeAction,
                fullPath: validation.escapePath,
                fullPathCoordinates: validation.escapeCoordinates || [],
              }
            } else {
              console.log(`   ❌ BOMB VALIDATION FAILED: ${validation.reason}`)
              if (validation.escapeTime && validation.availableTime) {
                console.log(
                  `      Need ${validation.escapeTime.toFixed(0)}ms but only ${validation.availableTime.toFixed(0)}ms available`,
                )
              }
            }
          }
        } else {
          console.log(`   ❌ No bombs available`)
        }
      } // Close the chestCell === "C" check

      // Don't return STAY - continue to find other chest positions or collect items
    }

    // Find best bombing positions for chests using bomb range (not just adjacent)
    const rangeBombingPositions = []
    const positionScores = new Map()

    // For each chest, check positions within bomb range (1 to explosionRange tiles)
    for (const chest of chests) {
      // Check all 4 directions within range
      for (const [dx, dy] of DIRS) {
        // Check from 1 to explosionRange tiles away
        for (let distance = 1; distance <= myBomber.explosionRange; distance++) {
          const bombX = chest.x + dx * distance
          const bombY = chest.y + dy * distance
          const key = posKey(bombX, bombY)

          // Skip if already checked this position
          if (positionScores.has(key)) continue

          // Must be walkable
          if (!map[bombY] || !WALKABLE.includes(map[bombY][bombX])) continue

          // Skip if bomb already there
          const hasBomb = bombs.some((b) => {
            const { gridX, gridY } = getBombWithGrid(b)
            return gridX === bombX && gridY === bombY
          })
          if (hasBomb) continue

          // Check if this position can actually hit the chest
          // (no walls blocking between bomb position and chest)
          let canHit = true
          for (let d = 1; d < distance; d++) {
            const checkX = chest.x + dx * d
            const checkY = chest.y + dy * d
            if (!map[checkY] || !WALKABLE.includes(map[checkY][checkX])) {
              canHit = false
              break
            }
          }

          if (canHit) {
            // Count how many chests this position can destroy
            const chestCount = countChestsDestroyedByBomb(
              bombX,
              bombY,
              map,
              myBomber.explosionRange,
            )
            const distanceToPlayer = Math.abs(bombX - player.x) + Math.abs(bombY - player.y)

            // EARLY GAME: Prioritize chest count heavily (destroy multiple chests > close distance)
            // LATER GAME: Balance chest count and distance more evenly
            const isEarlyWithManyChests = gamePhase === "EARLY" && allChests.length > 5
            let priorityScore
            if (isEarlyWithManyChests) {
              // Early game: chest count is 10x more important than distance
              // Example: 3 chests at distance 5 = 30 - 5 = 25
              // Example: 2 chests at distance 1 = 20 - 1 = 19
              priorityScore = chestCount.count * 10 - distanceToPlayer
            } else {
              // Later game: balance chest count and distance
              // Example: 3 chests at distance 5 = 3 - 10 = -7
              // Example: 2 chests at distance 1 = 2 - 2 = 0
              priorityScore = chestCount.count - distanceToPlayer * 2
            }

            positionScores.set(key, chestCount.count)
            rangeBombingPositions.push({
              x: bombX,
              y: bombY,
              chestCount: chestCount.count,
              distance: distanceToPlayer,
              priorityScore: priorityScore,
            })
          }
        }
      }
    }

    // Sort by priority score (considers both chest count and distance)
    // Higher score = better target (more chests, closer distance)
    rangeBombingPositions.sort((a, b) => b.priorityScore - a.priorityScore)

    console.log(`   Range-based chest bombing positions: ${rangeBombingPositions.length}`)
    if (rangeBombingPositions.length > 0) {
      const best = rangeBombingPositions[0]
      const isEarlyWithManyChests = gamePhase === "EARLY" && allChests.length > 5
      console.log(
        `   Best position would destroy ${best.chestCount} chest(s) at distance ${best.distance} (score: ${best.priorityScore.toFixed(1)})`,
      )
      if (isEarlyWithManyChests) {
        console.log(`   🎯 EARLY GAME MODE: Prioritizing chest count (10x) over distance`)
      }
    }

    if (rangeBombingPositions.length) {
      const bestTargets = rangeBombingPositions.filter(
        (t) => t.chestCount === rangeBombingPositions[0].chestCount,
      )

      console.log(`   🎯 Attempting to path to ${bestTargets.length} best bombing position(s)...`)
      console.log(
        `      Targets: ${bestTargets
          .slice(0, 5)
          .map((t) => `[${t.x},${t.y}](${t.chestCount})`)
          .join(", ")}`,
      )

      chestResult = findSafePath(map, player, bestTargets, bombs, bombers, myUid)

      // FALLBACK: If no safe path found, try findBestPath (relaxed timing)
      if (!chestResult && bestTargets.length > 0) {
        console.log(`   ⚠️ No safe path found, trying relaxed path search...`)
        chestResult = findBestPath(map, player, bestTargets, bombs, bombers, myUid, false)
        if (chestResult && chestResult.path.length > 0) {
          console.log(
            `   ✅ Found relaxed path to chest position (${chestResult.path.length} steps)`,
          )
        }
      }

      // FALLBACK 2: If still no path, try ANY chest position (even with fewer chests)
      if (!chestResult && rangeBombingPositions.length > bestTargets.length) {
        console.log(`   ⚠️ No path to best positions, trying ANY reachable chest position...`)
        // Try all positions sorted by chest count (best first)
        const allSorted = [...rangeBombingPositions].sort((a, b) => b.chestCount - a.chestCount)

        for (let i = 0; i < Math.min(20, allSorted.length); i++) {
          const target = allSorted[i]
          const singlePath = findBestPath(map, player, [target], bombs, bombers, myUid, false)

          if (singlePath && singlePath.path.length > 0) {
            console.log(
              `   ✅ Found path to position [${target.x},${target.y}] with ${target.chestCount} chest(s) (${singlePath.path.length} steps)`,
            )
            chestResult = singlePath
            break
          }
        }
      }

      if (chestResult) {
        console.log(
          `   ✅ Path to chest bombing position: ${chestResult.path.join(" → ")} (${chestResult.path.length} steps)`,
        )
      } else {
        console.log(`   ❌ No path found to any chest bombing positions`)
        console.log(
          `      This usually means: (1) All positions blocked by bombs/walls, (2) Timing unsafe, or (3) No walkable path`,
        )

        // DEBUG: Check if player is already at a good bombing position
        const playerAtGoodPosition = rangeBombingPositions.find(
          (t) => t.x === player.x && t.y === player.y,
        )
        if (playerAtGoodPosition) {
          console.log(
            `   💡 Player is ALREADY at bombing position [${player.x},${player.y}] (${playerAtGoodPosition.chestCount} chests)!`,
          )
          // Create a fake result to trigger bombing
          chestResult = {
            path: [], // Already at position
            walls: [],
          }
        }
      }
    }
  }

  // PHASE 4: Target Prioritization
  console.log(`\n🔍 PHASE 4: Target Prioritization`)
  let chosenResult = null
  let targetType = null

  if (itemResult && chestResult) {
    console.log(
      `   Comparing: Item(${itemResult.path.length}) vs Chest(${chestResult.path.length}) + Bias(${ITEM_PRIORITY_BIAS})`,
    )
    if (itemResult.path.length <= chestResult.path.length + ITEM_PRIORITY_BIAS) {
      console.log("   ✅ Prioritizing ITEM over chest")
      chosenResult = itemResult
      targetType = "ITEM"
    } else {
      console.log("   ✅ Prioritizing CHEST over item")
      chosenResult = chestResult
      targetType = "CHEST"
    }
  } else if (itemResult) {
    console.log("   ✅ Only ITEM found")
    chosenResult = itemResult
    targetType = "ITEM"
  } else if (chestResult) {
    console.log("   ✅ Only CHEST found")
    chosenResult = chestResult
    targetType = "CHEST"
  } else {
    console.log("   ❌ No items or chests found")
  }

  // PHASE 5: Execute chosen target
  if (chosenResult) {
    console.log(`\n🔍 PHASE 5: Target Execution (${targetType})`)
    const targetAction = handleTarget(chosenResult, state, myUid)

    // If handleTarget returns null, it means we should skip to exploration
    // (e.g., would destroy items, so we want to find better position)
    if (targetAction) {
      return targetAction
    }
    // Otherwise, continue to PHASE 6 exploration
  }

  // PHASE 5.5: Enemy Pursuit & Defense (REFACTORED)
  console.log(`\n🔍 PHASE 5.5: Enemy Pursuit & Defense`)
  console.log(`   Enemies found: ${enemies.length}`)
  console.log(`   Strategy: ${fightOrFlee.toUpperCase()}`)

  if (enemies.length > 0) {
    // Use unified enemy bombing system for defense mode
    const defenseResult = decideEnemyBombing({
      mode: "defense",
      enemies,
      player,
      myBomber,
      map,
      bombs,
      bombers,
      myUid,
      trackDecision,
    })

    if (defenseResult) {
      return defenseResult
    }

    // PURSUIT MODE: Only chase enemies if strategy is FIGHT
    if (fightOrFlee === "fight") {
      console.log(`   🎯 FIGHT mode - actively pursuing enemies`)

      // Use unified enemy bombing system for pursuit mode
      const pursuitResult = decideEnemyBombing({
        mode: "pursuit",
        enemies,
        player,
        myBomber,
        map,
        bombs,
        bombers,
        myUid,
        trackDecision,
      })

      if (pursuitResult) {
        return pursuitResult
      }
    } else {
      console.log(`   🛡️ FLEE/NEUTRAL mode - skipping active pursuit (defense only)`)
    }
  }

  // PHASE 6: Explore
  console.log(`\n🔍 PHASE 6: Exploration`)
  console.log(`   Safe tiles available: ${safeTiles.length}`)

  // Debug: Check immediate surroundings
  console.log(`   Immediate surroundings at [${player.x},${player.y}]:`)
  for (const [dx, dy, dir] of DIRS) {
    const nx = player.x + dx
    const ny = player.y + dy
    if (inBounds(nx, ny)) {
      const cell = map[ny][nx]
      const isWalkable = WALKABLE.includes(cell)
      console.log(
        `     ${dir}: [${nx},${ny}] = "${cell}" ${isWalkable ? "✓ walkable" : "✗ blocked"}`,
      )
    } else {
      console.log(`     ${dir}: OUT OF BOUNDS`)
    }
  }

  if (safeTiles.length > 0) {
    // Filter out current position from safe tiles
    const otherSafeTiles = safeTiles.filter((t) => t.x !== player.x || t.y !== player.y)

    console.log(`   Trying to path to ${otherSafeTiles.length} safe tiles...`)
    console.log(
      `   Sample safe tiles:`,
      safeTiles
        .slice(0, 5)
        .map((t) => `[${t.x},${t.y}]`)
        .join(", "),
    )

    if (otherSafeTiles.length > 0) {
      console.log(`   🛡️  Finding safe path to exploration tiles...`)
      let explorePath = findSafePath(map, player, otherSafeTiles, bombs, bombers, myUid, enemies)

      // If the best exploration path is only a single step, try to find a longer path
      // to reduce immediate oscillation between two tiles (ping-pong).
      if (explorePath && explorePath.path.length === 1) {
        console.log(`   ⚠️ Exploration path is only 1 step, searching for longer alternative...`)
        // Sort otherSafeTiles by distance (farthest first) and try to find an alternative path
        const byDistance = otherSafeTiles
          .slice()
          .sort(
            (a, b) =>
              Math.abs(b.x - player.x) +
              Math.abs(b.y - player.y) -
              (Math.abs(a.x - player.x) + Math.abs(a.y - player.y)),
          )

        // LIMIT: Only try first 10 farthest tiles to avoid infinite loop
        const MAX_EXPLORATION_ATTEMPTS = 10
        const tilesToTry = byDistance.slice(0, MAX_EXPLORATION_ATTEMPTS)
        console.log(
          `   🔍 Trying ${tilesToTry.length} farthest tiles for longer path (max ${MAX_EXPLORATION_ATTEMPTS})...`,
        )

        for (const t of tilesToTry) {
          if (t.x === player.x && t.y === player.y) continue
          const alt = findSafePath(map, player, [t], bombs, bombers, myUid)
          if (alt && alt.path.length > 1) {
            console.log(`   ✅ Found longer path: ${alt.path.length} steps`)
            explorePath = alt
            break
          }
        }
      }

      if (explorePath && explorePath.path.length > 0) {
        // Apply backtrack guard to avoid immediate A<->B oscillation
        const firstAction = explorePath.path[0]
        const guarded = applyBacktrackGuard(firstAction, player, map, bombs, bombers)

        if (guarded === "STAY") {
          console.log(`   ⚠️ Backtrack guard prevented oscillation — staying this tick`)
          console.log("=".repeat(90) + "\n")
          trackDecision(player, "STAY")
          return { action: "STAY" }
        }

        console.log(`   ✅ Exploration path: ${explorePath.path.join(" → ")}`)
        console.log("🎯 DECISION: EXPLORE")
        console.log("   Action:", guarded)

        // If backtrack guard changed the action, invalidate fullPath (can't follow anymore)
        const fullPathToUse = guarded === firstAction ? explorePath.path : null
        if (guarded !== firstAction) {
          console.log(
            `   ⚠️ Backtrack guard changed action ${firstAction} → ${guarded}, invalidating fullPath`,
          )
          isFollowingPath = false
        } else if (fullPathToUse && fullPathToUse.length > 1) {
          // Mark that we're following a multi-step path
          isFollowingPath = true
          console.log(`   📍 Following ${fullPathToUse.length}-step exploration path`)
        }

        console.log("=".repeat(90) + "\n")
        trackDecision(player, guarded)
        // Return full exploration path only if action wasn't changed by guard
        return fullPathToUse ? { action: guarded, fullPath: fullPathToUse } : { action: guarded }
      } else {
        console.log(`   ❌ No exploration path found (likely trapped by walls/chests)`)
      }
    } else {
      // We're at the only safe tile - just pick any walkable adjacent direction
      console.log(`   ⚠️ Current position is the only safe tile, moving to adjacent walkable tile`)

      for (const [dx, dy, dir] of DIRS) {
        const nx = player.x + dx
        const ny = player.y + dy

        if (inBounds(nx, ny) && WALKABLE.includes(map[ny][nx])) {
          // Check if there's no bomb at this tile
          const hasBomb = bombs.some((b) => {
            const { gridX, gridY } = getBombWithGrid(b)
            return gridX === nx && gridY === ny
          })

          if (!hasBomb) {
            console.log(`   ✅ Moving ${dir} to [${nx},${ny}]`)
            console.log("🎯 DECISION: EXPLORE (adjacent move)")
            console.log("=".repeat(90) + "\n")
            trackDecision(player, dir)
            // Return single-step fullPath for client follow consistency
            return {
              action: dir,
              fullPath: [dir],
              fullPathCoordinates: [], // Single move doesn't need coordinates
            }
          }
        }
      }

      console.log(`   ❌ No walkable adjacent tiles without bombs`)
    }
  } else {
    console.log(`   ⚠️ No safe tiles available`)
  }

  // PHASE 6.5: Break out of isolation by bombing nearby obstacles
  if (canPlaceBomb(myBomber, bombs, myUid)) {
    console.log(`\n🔍 PHASE 6.5: Obstacle Breaking (Trapped Escape)`)

    // Check if we can bomb to break walls/chests around us
    const nearbyObstacles = []
    for (const [dx, dy, dir] of DIRS) {
      const nx = player.x + dx
      const ny = player.y + dy

      if (inBounds(nx, ny)) {
        const cell = map[ny][nx]
        if (BREAKABLE.includes(cell)) {
          nearbyObstacles.push({ x: nx, y: ny, type: cell, direction: dir })
        }
      }
    }

    console.log(`   Found ${nearbyObstacles.length} adjacent breakable obstacles`)

    if (nearbyObstacles.length > 0) {
      // Check how many obstacles a bomb would destroy
      const obstaclesInRange = []
      for (const [dx, dy] of DIRS) {
        for (let step = 1; step <= myBomber.explosionRange; step++) {
          const nx = player.x + dx * step
          const ny = player.y + dy * step

          if (!inBounds(nx, ny)) break

          const cell = map[ny][nx]
          if (BREAKABLE.includes(cell)) {
            obstaclesInRange.push({ x: nx, y: ny, type: cell })
          }

          // Stop at first blocking cell
          if (!WALKABLE.includes(cell)) break
        }
      }

      console.log(`   Bombing here would destroy ${obstaclesInRange.length} obstacles`)
      console.log(`   Obstacle types:`, obstaclesInRange.map((o) => o.type).join(", "))

      // Only bomb if we can destroy obstacles and escape safely
      if (obstaclesInRange.length > 0) {
        // CRITICAL: Use full validation to prevent self-trap scenarios
        const validation = validateBombSafety(player, map, bombs, bombers, myBomber, myUid)

        if (validation.canBomb) {
          console.log(`   ✅ Can bomb obstacles and escape safely!`)
          console.log(`🎯 DECISION: BOMB (Break Out) + ESCAPE`)
          console.log("=".repeat(90) + "\n")
          return {
            action: "BOMB",
            isEscape: true,
            escapeAction: validation.escapeAction,
            fullPath: validation.escapePath,
            fullPathCoordinates: validation.escapeCoordinates || [],
          }
        } else {
          console.log(`   ⚠️ Cannot bomb safely: ${validation.reason}`)
          if (validation.reason === "escape_trapped") {
            console.log(`      🚫 Bombing would create deadlock - REFUSING TO BOMB`)
          }
        }
      }
    } else {
      console.log(`   ⚠️ No breakable obstacles adjacent to bomb`)
    }
  } else {
    console.log(`   ⚠️ No bombs available to break obstacles`)
  }

  console.log("🎯 DECISION: STAY (No options)")
  console.log("=".repeat(90) + "\n")
  trackDecision(player, "STAY")
  return { action: "STAY" }
}

// Re-export for backwards compatibility
export { findUnsafeTiles } from "./pathfinding/dangerMap.js"
