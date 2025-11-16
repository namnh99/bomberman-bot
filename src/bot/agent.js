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

    return dir
  }

  return "STAY"
}

/**
 * Handle movement/bombing when a target is found
 */
function handleTarget(result, state, myUid) {
  const { map, bombs = [], bombers } = state
  const myBomber = bombers && bombers.find((b) => b.uid === myUid)
  const player = toGridCoords(myBomber.x, myBomber.y)


  // If path is blocked by a chest, handle it
  if (result?.walls?.length > 0) {
    const targetWall = result.walls[0]

    if (isAdjacent(targetWall.x, targetWall.y, player.x, player.y)) {

      // CRITICAL: Use server's bomb placement logic to predict where bomb will be placed
      const bombPos = toBombGridCoords(myBomber.x, myBomber.y)

      // Check if bombing would destroy valuable items (using bomb position)
      const itemCheck = checkBombWouldDestroyItems(
        bombPos.x,
        bombPos.y,
        map,
        myBomber.explosionRange,
      )
      if (itemCheck.willDestroyItems) {
        return { action: "STAY" }
      }

      // Check chests that would be destroyed by bomb (using bomb position)
      const chestCount = countChestsDestroyedByBomb(
        bombPos.x,
        bombPos.y,
        map,
        myBomber.explosionRange,
      )

      // CRITICAL SAFETY CHECK: Validate bomb safety BEFORE placing
      const validation = validateBombSafety(bombPos, map, bombs, bombers, myBomber, myUid)

      if (!validation.canBomb) {
        if (validation.escapeTime && validation.availableTime) {
        }
        // Continue to next phase instead of bombing
      } else {
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
        imminentBombs.forEach((b) => {
          const { gridX, gridY } = getBombWithGrid(b)
          const timeLeft = getTimeUntilExplosion(b)
        })
        // Don't return - let it fall through to exploration phase
        return null
      }
    }

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

    // PRIORITY: Check if we're standing on an item tile
    const currentTile = map[player.y] && map[player.y][player.x]
    const isOnItemTile = ITEMS.includes(currentTile)

    if (isOnItemTile) {
      // Standing on item - move away to collect, don't try to bomb

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
            trackDecision(player, dir)
            return { action: dir }
          }
        }
      }

      return { action: "STAY" }
    }

    // CRITICAL: Use server's bomb placement logic to predict where bomb will be placed
    const bombPos = toBombGridCoords(myBomber.x, myBomber.y)

    // Check if there are chests adjacent to bomb position (not player position!)
    const chestCount = countChestsDestroyedByBomb(
      bombPos.x,
      bombPos.y,
      map,
      myBomber.explosionRange,
    )

    if (canPlaceBomb(myBomber, bombs, myUid)) {

      // Check if bombing would destroy items (using bomb position)
      const itemCheck = checkBombWouldDestroyItems(
        bombPos.x,
        bombPos.y,
        map,
        myBomber.explosionRange,
      )
      if (itemCheck.willDestroyItems) {

        // Don't stay here - return null to let main function continue to PHASE 6
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
            } else {

              return {
                action: "BOMB",
                escapeAction: escapePath.path[0],
                isEscape: true,
                fullPath: escapePath.path,
                fullPathCoordinates: escapePath.fullPathCoordinates || [],
              }
            }
          } else {
          }
        } else {
        }
      } // End of else block - only bomb if won't destroy items
    }
    // If we reach here, no valid bomb action found at this position
    // Return null to let main function continue to exploration
  }

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
              lastPosition = null
              decisionCount = 0
              trackDecision(player, dir)
              return { action: dir }
            }
          }
        }
      }

      // No alternative found - reset oscillation state and STAY
      lastPosition = null
      lastDecision = null
      decisionCount = 0
      trackDecision(player, "STAY")
      return { action: "STAY" }
    }
  } else {
    decisionCount = 0
  }

  if (bombs.length > 0) {
    bombs.forEach((b, i) => {
      const { gridX, gridY } = getBombWithGrid(b)
    })
  }

  // Show bomb capacity info
  const myActiveBombs = bombs.filter((b) => b.uid === myUid).length
  const remainingBombs = getRemainingBombs(myBomber, bombs, myUid)

  // PHASE 0: Game Context Analysis
  const enemies = findAllEnemies(bombers, myUid)
  const allItems = findAllItems(map, bombs, bombers, false)
  const allChests = findAllChests(map, bombs, bombers, false)

  const gamePhase = determineGamePhase(myBomber, enemies, allItems, allChests)
  const riskTolerance = calculateRiskTolerance(myBomber, enemies, allItems, allChests)
  const fightOrFlee = shouldFightOrFlee(enemies, myBomber, player, {
    itemCount: allItems.length,
    chestCount: allChests.length,
  })


  // PHASE 1: Safety Check
  const { isPlayerSafe, safeTiles } = checkSafety(map, player, bombs, bombers, myBomber)

  if (!isPlayerSafe) {
    // Use unified escape system
    const escapeResult = findEscapeAction(map, player, bombs, bombers, myUid)
    if (escapeResult) {
      trackDecision(player, escapeResult.action)
      trackEscape(player.x, player.y) // Track that we're escaping from this position
      return escapeResult
    }

    trackDecision(player, "STAY")
    return { action: "STAY" }
  }

  // PHASE 1.5: Enemy Trap Detection (if aggressive) (REFACTORED)
  if (fightOrFlee === "fight" && enemies.length > 0 && canPlaceBomb(myBomber, bombs, myUid)) {

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

      if (isChainReactionWorthwhile(bestChain, riskTolerance)) {
        const validation = validateBombSafety(bestChain, map, bombs, bombers, myBomber, myUid)

        if (validation.canBomb && bestChain.distance === 0) {
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


    // Check if target enemy still exists and hasn't moved too far
    if (activeSpamSequence.targetEnemy) {
      const currentEnemy = enemies.find((e) => e.id === activeSpamSequence.targetEnemy.id)

      if (!currentEnemy) {
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
          activeSpamSequence = null
          // Continue to next phase
        } else {
        }
      }
    }

    // Check if spam sequence is still valid
    if (activeSpamSequence && timeSinceLastBomb >= SPAM_BOMB_COOLDOWN_MS) {
      const nextIndex = activeSpamSequence.currentIndex + 1

      if (nextIndex < activeSpamSequence.positions.length) {
        const nextPos = activeSpamSequence.positions[nextIndex]

        // Move to next spam position
        const pathToNext = findSafePath(map, player, [nextPos], bombs, bombers, myUid)

        if (pathToNext && pathToNext.path.length > 0) {
          // If already at position, BOMB immediately
          if (player.x === nextPos.x && player.y === nextPos.y) {

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

              trackDecision(player, "BOMB")

              return {
                action: "BOMB",
                isEscape: true,
                escapeAction: escapePath.path[0],
                fullPath: escapePath.path,
                mode: `spam_${activeSpamSequence.strategy}_continue`,
              }
            } else {
              activeSpamSequence = null
            }
          } else {
            // Move toward spam position
            trackDecision(player, pathToNext.path[0])

            return {
              action: pathToNext.path[0],
              mode: `spam_${activeSpamSequence.strategy}_move`,
            }
          }
        } else {
          activeSpamSequence = null
        }
      } else {
        activeSpamSequence = null
      }
    } else {
    }
  }

  // PHASE 1.7: Advanced Combat (HIGHEST PRIORITY - Smart Predictive Bombing)
  // NEW: Use advanced combat strategies (predictive, blocking, range bombing)
  if (fightOrFlee === "fight" && enemies.length > 0 && canPlaceBomb(myBomber, bombs, myUid)) {

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

  }

  // PHASE 2: Dynamic Item Prioritization
  // EARLY game with many chests: Only collect NEARBY items (≤5 steps), skip far items
  // MID/LATE game: Collect all accessible items
  const items = findAllItems(map, bombs, bombers, false)

  const isEarlyWithManyChests = gamePhase === "EARLY" && allChests.length > 5
  if (isEarlyWithManyChests) {
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
      return false
    }

    // ANTI-PING-PONG: Filter items at recently visited positions
    const wasRecentlyVisited = isRecentlyVisited(item.x, item.y)
    if (wasRecentlyVisited) {
      return false
    }

    // Keep item for consideration (will check timing during pathfinding)
    return true
  })

  // Log dangerous items separately
  const dangerousItems = accessibleItems.filter((item) => item.isInBlastZone)
  if (dangerousItems.length > 0) {
    dangerousItems.forEach((item) => {
    })
  }

  if (accessibleItems.length < items.length) {
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
    prioritizedItems.slice(0, 3).forEach((pi, idx) => {
      const riskTag = pi.item.isInBlastZone ? ` 🔥 ${pi.riskBonus || "RISKY"}` : ""
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
        topItems = nearbyItems
      }
    }

    const multiStrategy =
      topItems.length > 0
        ? compareSingleVsMultiTarget(player, topItems, map, bombs, bombers, myUid)
        : null

    if (multiStrategy) {
      if (multiStrategy.strategy === "multi") {
        itemResult = {
          path: multiStrategy.path.totalPath,
          isMultiTarget: true,
          targets: multiStrategy.path.targetCount,
        }
      } else {
        itemResult = multiStrategy.path
      }
    }
  }

  if (itemResult) {
  } else if (items.length > 0) {
  }

  // PHASE 3: Find Chests
  const chests = findAllChests(map, bombs, bombers)
  if (chests.length > 0) {
  }

  let chestResult = null
  if (chests.length) {
    // Check if adjacent to a chest
    const adjacentChest = chests.find((c) => isAdjacent(c.x, c.y, player.x, player.y))
    if (adjacentChest) {

      // Verify chest still exists in map (not already destroyed)
      const chestCell = map[adjacentChest.y] && map[adjacentChest.y][adjacentChest.x]
      if (chestCell !== "C") {
      } else {

        // CRITICAL: Use server's bomb placement logic
        const bombPos = toBombGridCoords(myBomber.x, myBomber.y)

        const bombAlreadyHere = bombs.some((bomb) => {
          const { gridX, gridY } = getBombWithGrid(bomb)
          return gridX === bombPos.x && gridY === bombPos.y
        })

        if (bombAlreadyHere) {
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

              return {
                action: "BOMB",
                isEscape: true,
                escapeAction: validation.escapeAction,
                fullPath: validation.escapePath,
                fullPathCoordinates: validation.escapeCoordinates || [],
              }
            } else {
              if (validation.escapeTime && validation.availableTime) {
              }
            }
          }
        } else {
        }
      } // Close the chestCell === "C" check

      // Don't return STAY - continue to find other chest positions or collect items
    }

    // Find best bombing positions for chests
    const adjacentTargetsWithScore = []
    const positionScores = new Map()

    for (const chest of chests) {
      for (const [dx, dy] of DIRS) {
        const adjX = chest.x + dx
        const adjY = chest.y + dy
        const key = posKey(adjX, adjY)

        if (map[adjY] && WALKABLE.includes(map[adjY][adjX])) {
          const hasBomb = bombs.some((b) => {
            const { gridX, gridY } = getBombWithGrid(b)
            return gridX === adjX && gridY === adjY
          })

          if (hasBomb) {
          } else {
            if (!positionScores.has(key)) {
              const chestCount = countChestsDestroyedByBomb(
                adjX,
                adjY,
                map,
                myBomber.explosionRange,
              )
              const distance = Math.abs(adjX - player.x) + Math.abs(adjY - player.y)

              // EARLY GAME: Prioritize chest count heavily (destroy multiple chests > close distance)
              // LATER GAME: Balance chest count and distance more evenly
              const isEarlyWithManyChests = gamePhase === "EARLY" && allChests.length > 5
              let priorityScore
              if (isEarlyWithManyChests) {
                // Early game: chest count is 10x more important than distance
                // Example: 3 chests at distance 5 = 30 - 5 = 25
                // Example: 2 chests at distance 1 = 20 - 1 = 19
                priorityScore = chestCount.count * 10 - distance
              } else {
                // Later game: balance chest count and distance
                // Example: 3 chests at distance 5 = 3 - 10 = -7
                // Example: 2 chests at distance 1 = 2 - 2 = 0
                priorityScore = chestCount.count - distance * 2
              }

              positionScores.set(key, chestCount.count)
              adjacentTargetsWithScore.push({
                x: adjX,
                y: adjY,
                chestCount: chestCount.count,
                distance: distance,
                priorityScore: priorityScore,
              })
            }
          }
        }
      }
    }

    // Sort by priority score (considers both chest count and distance)
    // Higher score = better target (more chests, closer distance)
    adjacentTargetsWithScore.sort((a, b) => b.priorityScore - a.priorityScore)

    if (adjacentTargetsWithScore.length > 0) {
      const best = adjacentTargetsWithScore[0]
      const isEarlyWithManyChests = gamePhase === "EARLY" && allChests.length > 5
      if (isEarlyWithManyChests) {
      }
    }

    if (adjacentTargetsWithScore.length) {
      const bestTargets = adjacentTargetsWithScore.filter(
        (t) => t.chestCount === adjacentTargetsWithScore[0].chestCount,
      )


      chestResult = findSafePath(map, player, bestTargets, bombs, bombers, myUid)

      // FALLBACK: If no safe path found, try findBestPath (relaxed timing)
      if (!chestResult && bestTargets.length > 0) {
        chestResult = findBestPath(map, player, bestTargets, bombs, bombers, myUid, false)
        if (chestResult && chestResult.path.length > 0) {
        }
      }

      // FALLBACK 2: If still no path, try ANY chest position (even with fewer chests)
      if (!chestResult && adjacentTargetsWithScore.length > bestTargets.length) {
        // Try all positions sorted by chest count (best first)
        const allSorted = [...adjacentTargetsWithScore].sort((a, b) => b.chestCount - a.chestCount)

        for (let i = 0; i < Math.min(20, allSorted.length); i++) {
          const target = allSorted[i]
          const singlePath = findBestPath(map, player, [target], bombs, bombers, myUid, false)

          if (singlePath && singlePath.path.length > 0) {
            chestResult = singlePath
            break
          }
        }
      }

      if (chestResult) {
      } else {

        // DEBUG: Check if player is already at a good bombing position
        const playerAtGoodPosition = adjacentTargetsWithScore.find(
          (t) => t.x === player.x && t.y === player.y,
        )
        if (playerAtGoodPosition) {
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
  let chosenResult = null
  let targetType = null

  if (itemResult && chestResult) {
    if (itemResult.path.length <= chestResult.path.length + ITEM_PRIORITY_BIAS) {
      chosenResult = itemResult
      targetType = "ITEM"
    } else {
      chosenResult = chestResult
      targetType = "CHEST"
    }
  } else if (itemResult) {
    chosenResult = itemResult
    targetType = "ITEM"
  } else if (chestResult) {
    chosenResult = chestResult
    targetType = "CHEST"
  } else {
  }

  // PHASE 5: Execute chosen target
  if (chosenResult) {
    const targetAction = handleTarget(chosenResult, state, myUid)

    // If handleTarget returns null, it means we should skip to exploration
    // (e.g., would destroy items, so we want to find better position)
    if (targetAction) {
      return targetAction
    }
    // Otherwise, continue to PHASE 6 exploration
  }

  // PHASE 5.5: Enemy Pursuit & Defense (REFACTORED)

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
    }
  }

  // PHASE 6: Explore

  // Debug: Check immediate surroundings
  for (const [dx, dy, dir] of DIRS) {
    const nx = player.x + dx
    const ny = player.y + dy
    if (inBounds(nx, ny)) {
      const cell = map[ny][nx]
      const isWalkable = WALKABLE.includes(cell)
    } else {
    }
  }

  if (safeTiles.length > 0) {
    // Filter out current position from safe tiles
    const otherSafeTiles = safeTiles.filter((t) => t.x !== player.x || t.y !== player.y)


    if (otherSafeTiles.length > 0) {
      let explorePath = findSafePath(map, player, otherSafeTiles, bombs, bombers, myUid, enemies)

      // If the best exploration path is only a single step, try to find a longer path
      // to reduce immediate oscillation between two tiles (ping-pong).
      if (explorePath && explorePath.path.length === 1) {
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

        for (const t of tilesToTry) {
          if (t.x === player.x && t.y === player.y) continue
          const alt = findSafePath(map, player, [t], bombs, bombers, myUid)
          if (alt && alt.path.length > 1) {
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
          trackDecision(player, "STAY")
          return { action: "STAY" }
        }


        // If backtrack guard changed the action, invalidate fullPath (can't follow anymore)
        const fullPathToUse = guarded === firstAction ? explorePath.path : null
        if (guarded !== firstAction) {
          isFollowingPath = false
        } else if (fullPathToUse && fullPathToUse.length > 1) {
          // Mark that we're following a multi-step path
          isFollowingPath = true
        }

        trackDecision(player, guarded)
        // Return full exploration path only if action wasn't changed by guard
        return fullPathToUse ? { action: guarded, fullPath: fullPathToUse } : { action: guarded }
      } else {
      }
    } else {
      // We're at the only safe tile - just pick any walkable adjacent direction

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

    }
  } else {
  }

  // PHASE 6.5: Break out of isolation by bombing nearby obstacles
  if (canPlaceBomb(myBomber, bombs, myUid)) {

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


      // Only bomb if we can destroy obstacles and escape safely
      if (obstaclesInRange.length > 0) {
        // CRITICAL: Use full validation to prevent self-trap scenarios
        const validation = validateBombSafety(player, map, bombs, bombers, myBomber, myUid)

        if (validation.canBomb) {
          return {
            action: "BOMB",
            isEscape: true,
            escapeAction: validation.escapeAction,
            fullPath: validation.escapePath,
            fullPathCoordinates: validation.escapeCoordinates || [],
          }
        } else {
          if (validation.reason === "escape_trapped") {
          }
        }
      }
    } else {
    }
  } else {
  }

  trackDecision(player, "STAY")
  return { action: "STAY" }
}

// Re-export for backwards compatibility
export { findUnsafeTiles } from "./pathfinding/dangerMap.js"
