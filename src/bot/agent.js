import {
  GRID_SIZE,
  DIRS,
  WALKABLE,
  BREAKABLE,
  ITEMS,
  ITEM_PRIORITY_BIAS,
  OSCILLATION_THRESHOLD,
  BOMB_EXPLOSION_TIME,
  STEP_DELAY,
} from "../utils/constants.js"
import { toGridCoords, posKey, isAdjacent, inBounds } from "../utils/gridUtils.js"
import { findBestPath, findSafePath, findShortestEscapePath } from "./pathfinding/index.js"
import { findSafeTiles, findUnsafeTiles } from "./pathfinding/dangerMap.js"
import { findSafeWaitingPosition } from "./strategy/stagedEscape.js"
import {
  findAllItems,
  findAllChests,
  findAllEnemies,
  checkBombWouldDestroyItems,
  countChestsDestroyedByBomb,
  willBombHitEnemy,
  checkSafety,
  attemptEscape,
  attemptEmergencyEscape,
  findTrapOpportunities,
  dynamicItemPriority,
  calculateRiskTolerance,
  determineGamePhase,
  findChainReactionOpportunities,
  isChainReactionWorthwhile,
  shouldFightOrFlee,
  validateBombSafety,
  compareSingleVsMultiTarget,
} from "./strategy/index.js"
import { findAdvancedEscapePath } from "./strategy/advancedEscape.js"

// Anti-oscillation: Track last position and decision
let lastPosition = null
let lastDecision = null
let decisionCount = 0
let isFollowingPath = false // Track if we're following a multi-step path
let lastEscapeFromPosition = null // Track position we just escaped from
let lastEscapeTime = 0
const ESCAPE_COOLDOWN_MS = 5000 // Don't return to escaped position for 5 seconds

/**
 * Create a future bomb object with proper timing info for escape path calculation
 */
function createFutureBomb(x, y, explosionRange, uid) {
  return {
    x: x * GRID_SIZE,
    y: y * GRID_SIZE,
    explosionRange,
    uid,
    createdAt: Date.now(),
    lifeTime: BOMB_EXPLOSION_TIME,
    isExploded: false,
    isFuture: true, // Flag to distinguish from real server bombs
  }
}

// Track recently visited positions to prevent ping-pong between adjacent tiles
let recentPositions = [] // Array of {x, y, time}
const POSITION_MEMORY_MS = 3000 // Remember positions for 3 seconds
const MAX_POSITION_MEMORY = 5 // Remember last 5 positions

// Anti-spam bombing: Track last bomb placement to avoid spamming same position
let lastBombPosition = null
let lastBombTime = 0
const BOMB_PLACEMENT_COOLDOWN_MS = 3000 // 3 seconds cooldown between bombing same spot

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

function canBombAtPosition(x, y) {
  const now = Date.now()
  const positionKey = posKey(x, y)

  if (lastBombPosition === positionKey && now - lastBombTime < BOMB_PLACEMENT_COOLDOWN_MS) {
    const timeLeft = ((BOMB_PLACEMENT_COOLDOWN_MS - (now - lastBombTime)) / 1000).toFixed(1)
    return false
  }

  return true
}

function recordBombPlacement(x, y) {
  lastBombPosition = posKey(x, y)
  lastBombTime = Date.now()
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
    if (!inBounds(nx, ny, map)) continue
    if (!WALKABLE.includes(map[ny][nx])) continue

    // CRITICAL: Check if this direction leads into danger
    if (unsafeTiles.has(posKey(nx, ny))) {
      continue
    }

    // ensure no active bomb occupying the tile (unless walkable bomb flag true)
    const hasBomb = bombs.some((b) => {
      const { x, y } = toGridCoords(b.x, b.y)
      return x === nx && y === ny && !b.walkable
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
      // Check bombing cooldown at this position
      if (!canBombAtPosition(player.x, player.y)) {
        return { action: "STAY" }
      }

      // Check if bombing would destroy valuable items
      const itemCheck = checkBombWouldDestroyItems(player.x, player.y, map, myBomber.explosionRange)
      if (itemCheck.willDestroyItems) {
        return { action: "STAY" }
      }

      const chestCount = countChestsDestroyedByBomb(
        player.x,
        player.y,
        map,
        myBomber.explosionRange,
      )

      const now = Date.now()
      const futureBombs = [
        ...bombs,
        createFutureBomb(player.x, player.y, myBomber.explosionRange, myBomber.uid),
      ]
      const futureSafeTiles = findSafeTiles(state.map, futureBombs, bombers, myBomber)

      if (futureSafeTiles.length > 0) {
        // Use findShortestEscapePath to ensure escape destination is not trapped
        const escapePath = findShortestEscapePath(map, player, futureBombs, bombers, myBomber)

        if (escapePath && escapePath.path.length > 0) {
          if (myBomber.bombCount > 0) {
            // Record bomb placement to prevent spam
            recordBombPlacement(player.x, player.y)

            return {
              action: "BOMB",
              escapeAction: escapePath.path[0],
              isEscape: true,
              fullPath: escapePath.path,
            }
          }
        } else {
        }
      } else {
      }
    } else {
    }
    return { action: "STAY" }
  }

  // Move towards target
  if (result.path.length > 0) {
    trackDecision(player, result.path[0])
    // Return the full path so the client can follow the entire route and avoid local oscillation
    return { action: result.path[0], fullPath: result.path }
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

        if (inBounds(nx, ny, map) && WALKABLE.includes(map[ny][nx])) {
          const hasBomb = bombs.some((b) => {
            const { x, y } = toGridCoords(b.x, b.y)
            return x === nx && y === ny && !b.walkable
          })

          if (!hasBomb) {
            trackDecision(player, dir)
            return { action: dir }
          }
        }
      }

      return { action: "STAY" }
    }

    // Check if there are chests adjacent to bomb
    const chestCount = countChestsDestroyedByBomb(player.x, player.y, map, myBomber.explosionRange)

    if (chestCount.count > 0 && myBomber.bombCount > 0) {
      // Check bombing cooldown
      if (!canBombAtPosition(player.x, player.y)) {
        return { action: "STAY" }
      }

      // Check if bombing would destroy items
      const itemCheck = checkBombWouldDestroyItems(player.x, player.y, map, myBomber.explosionRange)
      if (itemCheck.willDestroyItems) {
        // Don't stay here - return null to let main function continue to PHASE 6
        return null // Signal to continue to exploration phase
      } else {
        // Only proceed with bombing if we won't destroy items

        // Validate escape path
        const futureBombs = [
          ...bombs,
          createFutureBomb(player.x, player.y, myBomber.explosionRange, myBomber.uid),
        ]
        const futureSafeTiles = findSafeTiles(map, futureBombs, bombers, myBomber)

        if (futureSafeTiles.length > 0) {
          // CRITICAL: Use findShortestEscapePath instead of findBestPath
          // This ensures the escape destination has valid exits (not deadlocked by walls/chests)
          const escapePath = findShortestEscapePath(
            map,
            player,
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
              recordBombPlacement(player.x, player.y)

              return {
                action: "BOMB",
                escapeAction: escapePath.path[0],
                isEscape: true,
                fullPath: escapePath.path,
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
    return { action: "STAY" }
  }

  const player = toGridCoords(myBomber.x, myBomber.y)

  // Reset following path flag when new decision is needed
  // This prevents backtrack guard from blocking valid paths
  isFollowingPath = false

  // --- Push current position into short history (keep last 4) ---
  // const currentPosKeyForHistory = posKey(player.x, player.y)
  // recentPositions.push(currentPosKeyForHistory)
  // if (recentPositions.length > 4) recentPositions.shift()

  // // Detect simple ping-pong pattern: [A,B,A,B] -> break oscillation
  // if (
  //   recentPositions.length === 4 &&
  //   recentPositions[0] === recentPositions[2] &&
  //   recentPositions[1] === recentPositions[3] &&
  //   recentPositions[0] !== recentPositions[1]
  // ) {
  //   recentPositions = [] // reset history so we don't continuously trigger
  //   if (lastDecision) {
  //     const guarded = applyBacktrackGuard(lastDecision, player, map, bombs, bombers)
  //     return { action: guarded }
  //   }
  //   return { action: "STAY" }
  // }

  // Anti-oscillation check
  const currentPosKey = posKey(player.x, player.y)
  if (lastPosition === currentPosKey && lastDecision) {
    decisionCount++
    if (decisionCount >= OSCILLATION_THRESHOLD) {
      // Keep the same decision to commit to the path
      lastPosition = null
      decisionCount = 0
      const guarded = applyBacktrackGuard(lastDecision, player, map, bombs, bombers)
      return { action: guarded }
    }
  } else {
    decisionCount = 0
  }

  if (bombs.length > 0) {
    bombs.forEach((b, i) => {
      const { x, y } = toGridCoords(b.x, b.y)
    })
  }

  // PHASE 0: Game Context Analysis
  const enemies = findAllEnemies(map, bombs, bombers, myUid)
  const allItems = findAllItems(map, bombs, bombers)
  const allChests = findAllChests(map, bombs, bombers)

  const gamePhase = determineGamePhase(myBomber, enemies, allItems, allChests)
  const riskTolerance = calculateRiskTolerance(myBomber, enemies, allItems, allChests)
  const fightOrFlee = shouldFightOrFlee(enemies, myBomber, player, {
    itemCount: allItems.length,
    chestCount: allChests.length,
  })

  // PHASE 1: Safety Check
  const { isPlayerSafe, safeTiles } = checkSafety(map, player, bombs, bombers, myBomber)

  // CRITICAL: Check staged escape EVEN WHEN SAFE for multi-bomb scenarios
  // Bot might be safe NOW but moving could put it in danger
  // Only consider bombs that could REALISTICALLY affect the bot (timing-based, not distance)
  const relevantBombs = bombs.filter((bomb) => {
    if (bomb.isExploded) return false

    const now = Date.now()
    const bombCreatedAt = bomb.createdAt || now
    const bombLifeTime = bomb.lifeTime || BOMB_EXPLOSION_TIME
    const elapsedTime = Math.max(0, now - bombCreatedAt)

    if (elapsedTime >= bombLifeTime) return false // Already exploded

    const timeUntilExplosion = bombLifeTime - elapsedTime
    const { x: bx, y: by } = bomb
    const distance = Math.abs(bx - player.x) + Math.abs(by - player.y)

    // Calculate time needed to walk this distance
    const timeToReachBomb = distance * (STEP_DELAY + 680) // ~1360ms per tile

    // Only relevant if: (1) bomb will explode while we could still be affected, OR
    // (2) bomb is very close (within 3 tiles) regardless of timing
    return timeUntilExplosion < timeToReachBomb + 2000 || distance <= 3
  })

  if (relevantBombs.length >= 2) {
    // Check if staying in place is the best option
    const waitStrategy = findSafeWaitingPosition(player, map, bombs, bombers, myUid)

    if (waitStrategy && waitStrategy.isStayingInPlace) {
      // STAY is the best option - current position safe from fastest bomb
      trackDecision(player, "STAY")
      if (!isPlayerSafe) trackEscape(player.x, player.y)
      return {
        action: "STAY",
        isEscape: !isPlayerSafe,
        isWaitingStrategy: true,
        waitPosition: waitStrategy.waitPosition,
        waitTime: waitStrategy.waitTime,
      }
    }
  }

  if (!isPlayerSafe) {
    // For multi-bomb scenarios (2+ bombs), try advanced timing escape
    if (relevantBombs.length >= 2) {
      const advancedEscape = findAdvancedEscapePath(player, map, bombs, bombers, myBomber)

      if (advancedEscape && advancedEscape.path && advancedEscape.path.length > 0) {
        trackDecision(player, advancedEscape.path[0])
        trackEscape(player.x, player.y) // Track that we're escaping from this position
        return {
          action: advancedEscape.path[0],
          isEscape: true,
          fullPath: advancedEscape.path,
        }
      } else {
      }
    }

    const escapeResult = attemptEscape(map, player, bombs, bombers, myBomber, myUid)
    if (escapeResult) {
      trackDecision(player, escapeResult.action)
      trackEscape(player.x, player.y) // Track that we're escaping from this position
      return escapeResult
    }

    const emergencyResult = attemptEmergencyEscape(map, player, bombs, bombers, myBomber)
    if (emergencyResult) {
      trackDecision(player, emergencyResult.action)
      trackEscape(player.x, player.y) // Track that we're escaping from this position
      return emergencyResult
    }

    trackDecision(player, "STAY")
    return { action: "STAY" }
  }

  // PHASE 1.4: Critical Bomb Proximity Check
  // ABORT all non-escape actions if we're INSIDE a blast zone that will explode soon
  // This is DIFFERENT from distance check - we check if CURRENT POSITION is in danger
  const now = Date.now()
  const CRITICAL_TIME_THRESHOLD = 3000 // 3 seconds

  // Check if current position is in an ACTIVE blast zone that will explode soon
  const currentUnsafeTiles = findUnsafeTiles(map, bombs, bombers)
  const currentPositionKey = posKey(player.x, player.y)
  const isInBlastZone = currentUnsafeTiles.has(currentPositionKey)

  if (isInBlastZone && isPlayerSafe) {
    // We're in a blast zone but marked as "safe" - check timing more carefully

    // Find which bombs threaten us
    const threateningBombs = []
    for (const bomb of bombs) {
      if (bomb.isExploded) continue

      const { x: bombX, y: bombY } = toGridCoords(bomb.x, bomb.y)
      const owner = bombers.find((b) => b.uid === bomb.uid)
      const range = owner ? owner.explosionRange : 2

      // Check if we're in this bomb's blast range
      const inRange =
        (bombX === player.x && Math.abs(bombY - player.y) <= range) ||
        (bombY === player.y && Math.abs(bombX - player.x) <= range)

      if (inRange) {
        const bombCreatedAt = bomb.createdAt || now
        const bombLifeTime = bomb.lifeTime || BOMB_EXPLOSION_TIME
        const elapsedTime = Math.max(0, now - bombCreatedAt)

        if (elapsedTime < bombLifeTime) {
          const timeUntilExplosion = bombLifeTime - elapsedTime

          if (timeUntilExplosion <= CRITICAL_TIME_THRESHOLD) {
            threateningBombs.push({
              bomb,
              bombX,
              bombY,
              timeUntilExplosion,
              distance: Math.abs(bombX - player.x) + Math.abs(bombY - player.y),
            })
          }
        }
      }
    }

    if (threateningBombs.length > 0) {
      threateningBombs.forEach((t) => {})

      // Calculate if we have time to escape
      const fastestBomb = threateningBombs.sort(
        (a, b) => a.timeUntilExplosion - b.timeUntilExplosion,
      )[0]
      const timeToEscape = STEP_DELAY + 680 // ~1 step to leave blast zone

      if (fastestBomb.timeUntilExplosion < timeToEscape) {
        trackDecision(player, "STAY")
        return { action: "STAY" }
      } else {
      }
    }
  }

  // PHASE 1.5: Enemy Trap Detection (if aggressive)
  if (fightOrFlee === "fight" && enemies.length > 0 && myBomber.bombCount > 0) {
    const trapOpportunities = findTrapOpportunities(enemies, map, myBomber, player)

    if (trapOpportunities.length > 0) {
      const bestTrap = trapOpportunities[0]

      if (bestTrap.willKill || (bestTrap.trapValue > 50 && riskTolerance > 0.6)) {
        const bombPos = bestTrap.bombPosition || player

        // Check bombing cooldown at this position
        if (!canBombAtPosition(bombPos.x, bombPos.y)) {
        } else {
          // Check if bombing would destroy items
          const itemCheck = checkBombWouldDestroyItems(
            bombPos.x,
            bombPos.y,
            map,
            myBomber.explosionRange,
          )
          if (itemCheck.willDestroyItems) {
          } else {
            // Validate bomb safety
            const validation = validateBombSafety(bombPos, map, bombs, bombers, myBomber, myUid)

            if (validation.canBomb) {
              // Check if we need to move to bomb position first
              if (bombPos.x === player.x && bombPos.y === player.y) {
                trackDecision(player, "BOMB")

                // Record bomb placement
                recordBombPlacement(bombPos.x, bombPos.y)

                return {
                  action: "BOMB",
                  isEscape: true,
                  escapeAction: validation.escapeAction,
                  fullPath: validation.escapePath,
                }
              } else {
                // Path to bomb position (use safe path to avoid bomb zones)
                const pathToTrap = findSafePath(map, player, [bombPos], bombs, bombers, myUid)
                if (pathToTrap && pathToTrap.path.length > 0) {
                  trackDecision(player, pathToTrap.path[0])
                  // Return full path so client can follow complete route to trap position
                  return { action: pathToTrap.path[0], fullPath: pathToTrap.path }
                }
              }
            }
          }
        }
      }
    }
  }

  // PHASE 1.6: Chain Reaction Detection
  if (bombs.length > 0 && myBomber.bombCount > 0 && riskTolerance > 0.5) {
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

  // PHASE 1.7: Aggressive Enemy Pursuit (HIGH PRIORITY - before items/chests)
  // This phase runs BEFORE item/chest collection to prioritize combat
  if (fightOrFlee === "fight" && enemies.length > 0 && myBomber.bombCount > 0) {
    for (const enemy of enemies) {
      const distance = Math.abs(enemy.x - player.x) + Math.abs(enemy.y - player.y)

      // ULTRA AGGRESSIVE: Pursue enemies within 12 tiles (was 8)
      if (distance <= 12) {
        // Find adjacent tiles to enemy
        const adjacentTargets = []
        for (const [adx, ady] of DIRS) {
          const tx = enemy.x + adx
          const ty = enemy.y + ady
          if (map[ty] && WALKABLE.includes(map[ty][tx])) {
            const hasBomb = bombs.some((b) => {
              const { x, y } = toGridCoords(b.x, b.y)
              return x === tx && y === ty
            })
            if (!hasBomb) adjacentTargets.push({ x: tx, y: ty })
          }
        }

        if (adjacentTargets.length > 0) {
          const pathToEnemy = findSafePath(map, player, adjacentTargets, bombs, bombers, myUid)

          if (pathToEnemy && pathToEnemy.path.length > 0) {
            // Calculate final position after following path
            let fx = player.x
            let fy = player.y
            for (const step of pathToEnemy.path) {
              if (step === "LEFT") fx -= 1
              if (step === "RIGHT") fx += 1
              if (step === "UP") fy -= 1
              if (step === "DOWN") fy += 1
            }
            const finalPos = { x: fx, y: fy }

            // Check if we can bomb enemy from final position
            const willHit = willBombHitEnemy(
              finalPos.x,
              finalPos.y,
              enemy.x,
              enemy.y,
              map,
              myBomber.explosionRange,
            )

            if (willHit) {
              // Check if bombing would destroy items
              const itemCheck = checkBombWouldDestroyItems(
                finalPos.x,
                finalPos.y,
                map,
                myBomber.explosionRange,
              )

              if (!itemCheck.willDestroyItems) {
                // Validate escape after bombing
                const futureBombs = [
                  ...bombs,
                  createFutureBomb(finalPos.x, finalPos.y, myBomber.explosionRange, myBomber.uid),
                ]
                const futureSafeTiles = findSafeTiles(map, futureBombs, bombers, myBomber)

                if (futureSafeTiles.length > 0) {
                  const escapePath = findBestPath(
                    map,
                    finalPos,
                    futureSafeTiles,
                    futureBombs,
                    bombers,
                    myUid,
                    true,
                  )

                  if (escapePath && escapePath.path.length > 0) {
                    trackDecision(player, pathToEnemy.path[0])
                    return {
                      action: pathToEnemy.path[0],
                      fullPath: pathToEnemy.path,
                      isPursuit: true,
                    }
                  }
                }
              } else {
              }
            }
          }
        }
      }
    }
  }

  // PHASE 2: Dynamic Item Prioritization
  const items = findAllItems(map, bombs, bombers)

  // CRITICAL: Classify items by danger level instead of filtering completely
  const unsafeTiles = findUnsafeTiles(map, bombs, bombers)
  const nowTime = Date.now()

  const itemsWithDanger = items.map((item) => {
    const itemKey = posKey(item.x, item.y)
    const isInBlastZone = unsafeTiles.has(itemKey)

    // Calculate time needed to REACH this item from current position
    const distanceToItem = Math.abs(item.x - player.x) + Math.abs(item.y - player.y)
    const timeToReachItem = distanceToItem * (STEP_DELAY + 680) // ~1360ms per tile

    // If item is in blast zone, calculate if we have time to grab it
    let timeUntilDanger = Infinity
    let canReachSafely = true

    if (isInBlastZone) {
      for (const bomb of bombs) {
        if (bomb.isExploded) continue

        const bombX = Math.floor(bomb.x / GRID_SIZE)
        const bombY = Math.floor(bomb.y / GRID_SIZE)
        const owner = bombers.find((b) => b.uid === bomb.uid)
        const range = owner ? owner.explosionRange : 2

        // Check if bomb affects this item
        const inRange =
          (bombX === item.x && Math.abs(bombY - item.y) <= range) ||
          (bombY === item.y && Math.abs(bombX - item.x) <= range)

        if (inRange) {
          const bombCreatedAt = bomb.createdAt || nowTime
          const bombLifeTime = bomb.lifeTime || BOMB_EXPLOSION_TIME
          const elapsedTime = Math.max(0, nowTime - bombCreatedAt)

          if (elapsedTime < bombLifeTime) {
            const bombTimeRemaining = bombLifeTime - elapsedTime
            timeUntilDanger = Math.min(timeUntilDanger, bombTimeRemaining)

            // Check if we can reach item BEFORE bomb explodes
            // Need extra time to grab and escape (add 1 tile safety margin)
            const safetyBuffer = (STEP_DELAY + 680) * 2 // 2 tiles worth of time
            if (timeToReachItem + safetyBuffer > bombTimeRemaining) {
              canReachSafely = false
            }
          }
        }
      }
    }

    return {
      ...item,
      isInBlastZone,
      timeUntilDanger,
      canReachSafely,
      distanceToItem,
      timeToReachItem,
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

    // TIMING-BASED SAFETY: Filter items that can't be reached safely
    if (item.isInBlastZone && !item.canReachSafely) {
      return false
    }

    // Keep item for consideration
    return true
  })

  // Log dangerous items separately
  const dangerousItems = accessibleItems.filter((item) => item.isInBlastZone)
  if (dangerousItems.length > 0) {
    dangerousItems.forEach((item) => {})
  }

  if (accessibleItems.length < items.length) {
  }

  // Apply dynamic prioritization to accessible items
  // BOOST priority for items in blast zones that we CAN reach safely (high risk, high reward)
  const prioritizedItems = accessibleItems
    .map((item) => {
      const priorityData = dynamicItemPriority(item, myBomber, enemies, player, gamePhase)

      // TIMING-BASED RISK BONUS: If item is in blast zone but we can grab it safely
      if (item.isInBlastZone && item.canReachSafely) {
        const timeMargin = item.timeUntilDanger - item.timeToReachItem
        // More bonus for tighter timing (higher risk = higher reward)
        const riskBonus = 1.5 + (1 - Math.min(timeMargin / 5000, 1)) * 0.5 // 1.5x to 2.0x bonus
        priorityData.finalValue *= riskBonus
        priorityData.riskBonus = riskBonus
      }

      return priorityData
    })
    .sort((a, b) => b.finalValue - a.finalValue)

  if (prioritizedItems.length > 0) {
    prioritizedItems.slice(0, 3).forEach((pi, idx) => {
      const riskTag = pi.item.isInBlastZone
        ? ` 🔥 RISKY (${pi.riskBonus ? `${pi.riskBonus.toFixed(2)}x bonus` : "filtered"})`
        : ""
    })
  }

  // Try multi-target path for items
  let itemResult = null
  if (prioritizedItems.length > 0) {
    const topItems = prioritizedItems.slice(0, 5).map((pi) => pi.item)
    const multiStrategy = compareSingleVsMultiTarget(player, topItems, map, bombs, bombers, myUid)

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
        const bombAlreadyHere = bombs.some((bomb) => {
          const { x, y } = toGridCoords(bomb.x, bomb.y)
          return x === player.x && y === player.y
        })

        if (bombAlreadyHere) {
          const escapePath = findShortestEscapePath(map, player, bombs, bombers, myBomber)
          if (escapePath && escapePath.path.length > 0) {
            return {
              action: escapePath.path[0],
              isEscape: true,
              fullPath: escapePath.path,
            }
          }
          return { action: "STAY" }
        }

        if (myBomber.bombCount > 0) {
          const itemCheck = checkBombWouldDestroyItems(
            player.x,
            player.y,
            map,
            myBomber.explosionRange,
          )
          if (itemCheck.willDestroyItems) {
            // Don't return here - continue to Phase 4 where item will be prioritized
          } else {
            // CRITICAL SAFETY: Check if there are bombs that could explode while we're bombing
            // Use TIMING calculation instead of distance
            const now = Date.now()
            const dangerousBombs = bombs.filter((b) => {
              if (b.isExploded) return false
              const bombCreatedAt = b.createdAt || now
              const bombLifeTime = b.lifeTime || BOMB_EXPLOSION_TIME
              const elapsedTime = Math.max(0, now - bombCreatedAt)

              if (elapsedTime >= bombLifeTime) return false // Skip expired

              const timeUntilExplosion = bombLifeTime - elapsedTime

              // Only dangerous if exploding soon (< 3s)
              if (timeUntilExplosion <= 0 || timeUntilExplosion >= 3000) return false

              // Check if bomb is in blast range or could affect our escape
              const { x: bombX, y: bombY } = toGridCoords(b.x, b.y)
              const owner = bombers.find((bomber) => bomber.uid === b.uid)
              const range = owner ? owner.explosionRange : 2

              // Check if we're in blast zone OR bomb is close enough to block escape
              const inBlastRange =
                (bombX === player.x && Math.abs(bombY - player.y) <= range) ||
                (bombY === player.y && Math.abs(bombX - player.x) <= range)

              if (inBlastRange) return true

              // Also check if bomb is close enough that we can't escape in time
              const distance = Math.abs(bombX - player.x) + Math.abs(bombY - player.y)
              const timeToEscapeBomb = distance * (STEP_DELAY + 680) // Time to walk away

              return timeUntilExplosion < timeToEscapeBomb
            })

            if (dangerousBombs.length > 0) {
              dangerousBombs.forEach((b) => {
                const { x, y } = toGridCoords(b.x, b.y)
                const bombCreatedAt = b.createdAt || now
                const bombLifeTime = b.lifeTime || BOMB_EXPLOSION_TIME
                const timeLeft = bombLifeTime - (now - bombCreatedAt)
                const distance = Math.abs(x - player.x) + Math.abs(y - player.y)
              })
            } else {
              const chestCount = countChestsDestroyedByBomb(
                player.x,
                player.y,
                map,
                myBomber.explosionRange,
              )

              if (chestCount.count > 0) {
                const now = Date.now()
                const futureBombs = [
                  ...bombs,
                  createFutureBomb(player.x, player.y, myBomber.explosionRange, myBomber.uid),
                ]
                const futureSafeTiles = findSafeTiles(map, futureBombs, bombers, myBomber)

                if (futureSafeTiles.length > 0) {
                  // Use findShortestEscapePath to ensure escape destination is not trapped
                  const escapePath = findShortestEscapePath(
                    map,
                    player,
                    futureBombs,
                    bombers,
                    myBomber,
                  )

                  if (escapePath && escapePath.path.length > 0) {
                    // CRITICAL DEADLOCK CHECK: Verify escape destination isn't a corridor trap
                    // Calculate where we'll end up after escape
                    let escapeDestX = player.x
                    let escapeDestY = player.y

                    for (const move of escapePath.path) {
                      if (move === "UP") escapeDestY--
                      else if (move === "DOWN") escapeDestY++
                      else if (move === "LEFT") escapeDestX--
                      else if (move === "RIGHT") escapeDestX++
                    }

                    // Count walkable neighbors at escape destination
                    const walkableNeighbors = []
                    for (const [dx, dy, dir] of DIRS) {
                      const nx = escapeDestX + dx
                      const ny = escapeDestY + dy

                      if (nx >= 0 && nx < map[0].length && ny >= 0 && ny < map.length) {
                        const cell = map[ny][nx]
                        const hasBomb = futureBombs.some((b) => {
                          const { x, y } = toGridCoords(b.x, b.y)
                          return x === nx && y === ny
                        })

                        if ((cell === null || cell === "S" || cell === "B") && !hasBomb) {
                          walkableNeighbors.push(dir)
                        }
                      }
                    }

                    // DEADLOCK: If escape destination has ≤ 1 exit, we'll be trapped!
                    if (walkableNeighbors.length <= 1) {
                    } else {
                      return {
                        action: "BOMB",
                        isEscape: true,
                        escapeAction: escapePath.path[0],
                        fullPath: escapePath.path,
                      }
                    }
                  } else {
                  }
                } else {
                }
              } else {
              }
            } // Close dangerous bombs check
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
            const { x, y } = toGridCoords(b.x, b.y)
            return x === adjX && y === adjY
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
              positionScores.set(key, chestCount.count)
              adjacentTargetsWithScore.push({
                x: adjX,
                y: adjY,
                chestCount: chestCount.count,
              })
            }
          }
        }
      }
    }

    adjacentTargetsWithScore.sort((a, b) => b.chestCount - a.chestCount)

    if (adjacentTargetsWithScore.length > 0) {
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

  // PHASE 5.5: Enemy Pursuit & Defense

  if (enemies.length > 0) {
    // DEFENSE MODE: Always bomb adjacent enemies (even in FLEE mode)
    // This is self-defense, not aggressive pursuit
    for (const enemy of enemies) {
      if (isAdjacent(enemy.x, enemy.y, player.x, player.y)) {
        if (myBomber.bombCount > 0) {
          // Check bombing cooldown
          if (!canBombAtPosition(player.x, player.y)) {
            continue
          }

          const itemCheck = checkBombWouldDestroyItems(
            player.x,
            player.y,
            map,
            myBomber.explosionRange,
          )
          if (itemCheck.willDestroyItems) {
            continue
          }

          const willHit = willBombHitEnemy(
            player.x,
            player.y,
            enemy.x,
            enemy.y,
            map,
            myBomber.explosionRange,
          )

          if (willHit) {
            const futureBombs = [
              ...bombs,
              createFutureBomb(player.x, player.y, myBomber.explosionRange, myBomber.uid),
            ]

            const futureSafeTiles = findSafeTiles(map, futureBombs, bombers, myBomber)
            if (futureSafeTiles.length > 0) {
              const escapePath = findBestPath(
                map,
                player,
                futureSafeTiles,
                futureBombs,
                bombers,
                myUid,
                true,
              )

              if (escapePath && escapePath.path.length > 0) {
                // Record bomb placement
                recordBombPlacement(player.x, player.y)

                return {
                  action: "BOMB",
                  isEscape: true,
                  escapeAction: escapePath.path[0],
                  fullPath: escapePath.path,
                  isDefense: true,
                }
              } else {
              }
            }
          } else {
          }
        } else {
        }
      }
    }

    // PURSUIT MODE: Only chase enemies if strategy is FIGHT
    if (fightOrFlee === "fight") {
      for (const enemy of enemies) {
        // Try to path to enemy-adjacent tile
        const adjacentTargets = []
        for (const [adx, ady] of DIRS) {
          const tx = enemy.x + adx
          const ty = enemy.y + ady
          if (map[ty] && WALKABLE.includes(map[ty][tx])) {
            const hasBomb = bombs.some((b) => {
              const { x, y } = toGridCoords(b.x, b.y)
              return x === tx && y === ty
            })
            if (!hasBomb) adjacentTargets.push({ x: tx, y: ty })
          }
        }

        if (adjacentTargets.length > 0) {
          const pathToAdj = findSafePath(map, player, adjacentTargets, bombs, bombers, myUid)
          if (pathToAdj && pathToAdj.path.length > 0) {
            if (myBomber.bombCount > 0) {
              let fx = player.x
              let fy = player.y
              for (const step of pathToAdj.path) {
                if (step === "LEFT") fx -= 1
                if (step === "RIGHT") fx += 1
                if (step === "UP") fy -= 1
                if (step === "DOWN") fy += 1
              }
              const finalPos = { x: fx, y: fy }

              // Check if final position would destroy items
              const itemCheck = checkBombWouldDestroyItems(
                finalPos.x,
                finalPos.y,
                map,
                myBomber.explosionRange,
              )
              if (itemCheck.willDestroyItems) {
              } else {
                const willHit = willBombHitEnemy(
                  finalPos.x,
                  finalPos.y,
                  enemy.x,
                  enemy.y,
                  map,
                  myBomber.explosionRange,
                )
                if (willHit) {
                  const futureBombs = [
                    ...bombs,
                    createFutureBomb(finalPos.x, finalPos.y, myBomber.explosionRange, myBomber.uid),
                  ]
                  const futureSafeTiles = findSafeTiles(map, futureBombs, bombers, myBomber)
                  if (futureSafeTiles.length > 0) {
                    const escapePath = findBestPath(
                      map,
                      finalPos,
                      futureSafeTiles,
                      futureBombs,
                      bombers,
                      myUid,
                      true,
                    )
                    if (escapePath && escapePath.path.length > 0) {
                      trackDecision(player, pathToAdj.path[0])
                      // Provide full path so client can follow complete route toward enemy
                      return { action: pathToAdj.path[0], fullPath: pathToAdj.path }
                    }
                  }
                }
              }
            } else {
              if (pathToAdj.path.length > 0) {
                trackDecision(player, pathToAdj.path[0])
                return { action: pathToAdj.path[0], fullPath: pathToAdj.path }
              }
            }
          }
        }
      }
    } else {
    }
  }

  // PHASE 6: Explore

  // Debug: Check immediate surroundings
  for (const [dx, dy, dir] of DIRS) {
    const nx = player.x + dx
    const ny = player.y + dy
    if (inBounds(nx, ny, map)) {
      const cell = map[ny][nx]
      const isWalkable = WALKABLE.includes(cell)
    } else {
    }
  }

  if (safeTiles.length > 0) {
    // Filter out current position from safe tiles
    const otherSafeTiles = safeTiles.filter((t) => t.x !== player.x || t.y !== player.y)

    if (otherSafeTiles.length > 0) {
      let explorePath = findSafePath(map, player, otherSafeTiles, bombs, bombers, myUid)

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

        if (inBounds(nx, ny, map) && WALKABLE.includes(map[ny][nx])) {
          // Check if there's no bomb at this tile
          const hasBomb = bombs.some((b) => {
            const { x, y } = toGridCoords(b.x, b.y)
            return x === nx && y === ny
          })

          if (!hasBomb) {
            trackDecision(player, dir)
            // Return single-step fullPath for client follow consistency
            return { action: dir, fullPath: [dir] }
          }
        }
      }
    }
  } else {
  }

  // PHASE 6.5: Break out of isolation by bombing nearby obstacles
  if (myBomber.bombCount > 0) {
    // Check if we can bomb to break walls/chests around us
    const nearbyObstacles = []
    for (const [dx, dy, dir] of DIRS) {
      const nx = player.x + dx
      const ny = player.y + dy

      if (inBounds(nx, ny, map)) {
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

          if (!inBounds(nx, ny, map)) break

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
        const futureBombs = [
          ...bombs,
          createFutureBomb(player.x, player.y, myBomber.explosionRange, myBomber.uid),
        ]
        const futureSafeTiles = findSafeTiles(map, futureBombs, bombers, myBomber)

        if (futureSafeTiles.length > 0) {
          const escapePath = findBestPath(
            map,
            player,
            futureSafeTiles,
            futureBombs,
            bombers,
            myUid,
            true,
          )

          if (escapePath && escapePath.path.length > 0) {
            return {
              action: "BOMB",
              isEscape: true,
              escapeAction: escapePath.path[0],
              fullPath: escapePath.path,
            }
          } else {
          }
        } else {
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
