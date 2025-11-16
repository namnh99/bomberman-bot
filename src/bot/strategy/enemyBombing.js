import { DIRS, WALKABLE } from "../../utils/constants.js"
import { createFutureBomb, getBombWithGrid } from "../../utils/bombUtils.js"
import { canPlaceBomb } from "../../utils/bomberUtils.js"
import { willBombHitEnemy } from "./targetSelector.js"
import {
  toBombGridCoords,
  isAdjacent,
  isWithinBombRange,
  calculateFinalPosition,
  manhattanDistance,
  isWalkable,
} from "../../utils/gridUtils.js"
import { findSafePath, findBestPath, findSafeTiles } from "../pathfinding/index.js"
import { findTrapOpportunities } from "./trapDetector.js"
import { decideAdvancedCombat } from "./advancedCombat.js"

/**
 * Calculate how many enemy escape routes this bomb position would block
 */
function calculateTrapScore(bombX, bombY, enemy, map, range) {
  let blockedRoutes = 0

  // Check all 4 escape directions from enemy
  for (const [dx, dy] of DIRS) {
    let routeBlocked = false

    // Check if this escape route is blocked by wall/bomb already
    const escapeX = enemy.x + dx
    const escapeY = enemy.y + dy
    if (!isWalkable(escapeX, escapeY, map)) {
      blockedRoutes++
      continue
    }

    // Check if bomb explosion would cover this escape route
    // Bomb creates explosion in 4 directions up to range
    for (const [bdx, bdy] of DIRS) {
      for (let step = 0; step <= range; step++) {
        const expX = bombX + bdx * step
        const expY = bombY + bdy * step

        // Check if explosion hits the escape tile
        if (expX === escapeX && expY === escapeY) {
          routeBlocked = true
          break
        }

        // Stop if hit wall
        if (!isWalkable(expX, expY, map) && !(expX === bombX && expY === bombY)) break
      }
      if (routeBlocked) break
    }

    if (routeBlocked) blockedRoutes++
  }

  return blockedRoutes // 0-4 (how many escape routes blocked)
}

/**
 * Find bombing positions within explosion range of enemy
 * FLEXIBLE: Can bomb from distance, not just adjacent!
 * PRIORITIZES: Trap capability (blocking enemy escape routes)
 * @returns {Array} Array of bombing positions sorted by priority
 */
function findRangeBasedBombingPositions(enemy, player, map, bombs, range) {
  const positions = []

  // Check all 4 directions within bomb range
  for (const [dx, dy, dir] of DIRS) {
    // Check positions from 1 to range tiles away from enemy
    for (let step = 1; step <= range; step++) {
      const bx = enemy.x + dx * step
      const by = enemy.y + dy * step

      // Check if position is valid
      if (!isWalkable(bx, by, map)) break

      // Check if bomb already exists
      const hasBomb = bombs.some((b) => {
        const { gridX, gridY } = getBombWithGrid(b)
        return gridX === bx && gridY === by
      })

      if (hasBomb) break

      const distanceFromPlayer = manhattanDistance(player.x, player.y, bx, by)
      const distanceFromEnemy = step

      // Calculate trap capability (how many escape routes blocked)
      const trapScore = calculateTrapScore(bx, by, enemy, map, range)

      positions.push({
        x: bx,
        y: by,
        direction: dir,
        distanceFromPlayer,
        distanceFromEnemy,
        trapScore, // 0-4 blocked routes
        // Priority: trap capability > close to enemy > close to player
        // trapScore * 100: prioritize trap (0-400 points)
        // distanceFromEnemy * 10: closer to enemy better (10-50 points)
        // distanceFromPlayer * 0.1: closer to player better (0-5 points)
        priority: -trapScore * 100 + distanceFromEnemy * 10 + distanceFromPlayer * 0.1,
      })

      // Take first valid position in this direction
      // (closest to enemy = best explosion zone coverage)
      break
    }
  }

  // Sort by priority (better trap first, then closer to enemy, then closer to player)
  positions.sort((a, b) => a.priority - b.priority)

  return positions
}

/**
 * Validate bomb placement and escape path
 * Centralizes common validation logic used across all bombing modes
 * @param {Object} bombPos - Position to place bomb {x, y}
 * @param {Object} enemy - Enemy position {x, y}
 * @param {Array} map - Game map
 * @param {Array} bombs - Active bombs
 * @param {Array} bombers - All bombers
 * @param {Object} myBomber - Current bomber
 * @param {string} myUid - Player UID
 * @param {boolean} aggressive - If true, allow risky timing-based escapes (for spam)
 * @returns {Object} { valid: boolean, reason: string, escapePath: Object, items: Array }
 */
function validateBombAndEscape(
  bombPos,
  enemy,
  map,
  bombs,
  bombers,
  myBomber,
  myUid,
  aggressive = false,
) {
  // Check if bomb would hit enemy
  const willHit = willBombHitEnemy(
    bombPos.x,
    bombPos.y,
    enemy.x,
    enemy.y,
    map,
    myBomber.explosionRange,
  )

  if (!willHit) {
    return {
      valid: false,
      reason: "no_hit",
    }
  }

  // Create future scenario with bomb placed
  const futureBombs = [
    ...bombs,
    createFutureBomb(bombPos.x, bombPos.y, myBomber.explosionRange, myBomber.uid),
  ]

  // Find safe tiles and escape path
  const futureSafeTiles = findSafeTiles(map, futureBombs, bombers, myBomber)
  if (futureSafeTiles.length === 0) {
    return {
      valid: false,
      reason: "no_safe_tiles",
    }
  }

  // SPAM MODE: Allow aggressive timing-based crossing for high-risk plays
  // NORMAL MODE: Conservative - avoid timing-based risks
  const escapePath = findBestPath(
    map,
    bombPos,
    futureSafeTiles,
    futureBombs,
    bombers,
    myUid,
    true, // isEscaping
    aggressive, // allowTimingCrossing - true for spam, false for normal
  )

  if (!escapePath || escapePath.path.length === 0) {
    return {
      valid: false,
      reason: "no_escape",
    }
  }

  return {
    valid: true,
    escapePath,
    futureBombs,
    futureSafeTiles,
  }
}

/**
 * Create standardized decision object
 * @param {string} action - Action to take
 * @param {Object} options - Additional options
 * @returns {Object} Standardized decision structure
 */
function createDecision(action, options = {}) {
  return {
    action,
    fullPath: options.fullPath || [],
    fullPathCoordinates: options.fullPathCoordinates || [],
    isEscape: options.isEscape || false,
    escapeAction: options.escapeAction || null,
    mode: options.mode || null,
    spamSequence: options.spamSequence || null, // Track ongoing spam sequence
    spamTarget: options.spamTarget || null, // Track spam target enemy position
    targetEnemy: options.targetEnemy || null, // Track target enemy object for locking
  }
}

/**
 * Unified enemy bombing decision
 * Handles all enemy bombing scenarios (trap, pursuit, defense)
 * @param {Object} params - Parameters
 * @returns {Object} decision or null
 */
export function decideEnemyBombing({
  mode = "default", // "trap", "priority_pursuit", "pursuit", "defense"
  enemies,
  player,
  myBomber,
  map,
  bombs,
  bombers,
  myUid,
  trackDecision,
  riskTolerance = 0.5,
  maxDistance = Infinity,
}) {
  if (!enemies || enemies.length === 0) {
    return null
  }

  // TRAP MODE: Find and exploit trap opportunities
  if (mode === "trap") {
    const trapOpportunities = findTrapOpportunities(enemies, map, myBomber, player)

    if (trapOpportunities.length > 0) {
      const bestTrap = trapOpportunities[0]

      if (bestTrap.willKill || (bestTrap.trapValue > 50 && riskTolerance > 0.6)) {
        const bombPos = bestTrap.bombPosition || player

        const validation = validateBombAndEscape(
          bombPos,
          bestTrap.enemyPos || enemies[0],
          map,
          bombs,
          bombers,
          myBomber,
          myUid,
        )

        if (!validation.valid) {
          if (validation.reason === "items") {
          } else {
          }
          return null
        }

        if (bombPos.x === player.x && bombPos.y === player.y) {
          trackDecision(player, "BOMB")

          return createDecision("BOMB", {
            isEscape: true,
            escapeAction: validation.escapePath.path[0],
            fullPath: validation.escapePath.path,
            fullPathCoordinates: validation.escapePath.fullPathCoordinates || [],
            mode: "trap",
          })
        } else {
          const pathToTrap = findSafePath(map, player, [bombPos], bombs, bombers, myUid)
          if (pathToTrap && pathToTrap.path.length > 0) {
            trackDecision(player, pathToTrap.path[0])

            return createDecision(pathToTrap.path[0], {
              fullPath: pathToTrap.path,
              fullPathCoordinates: pathToTrap.fullPathCoordinates || [],
              mode: "trap",
            })
          }
        }
      }
    }
    return null
  }

  // ADVANCED COMBAT MODE: Smart predictive & blocking strategies
  if (mode === "advanced_combat") {

    // Try advanced combat for each nearby enemy
    for (const enemy of enemies) {
      const distance = manhattanDistance(enemy.x, enemy.y, player.x, player.y)

      // Only try advanced combat for enemies within reasonable distance
      if (distance > 8) continue

      const combatDecision = decideAdvancedCombat(
        enemy,
        player,
        map,
        bombs,
        bombers,
        myBomber,
        myUid,
      )

      if (combatDecision) {
        const {
          position,
          strategy,
          escapePath,
          escapeCoordinates,
          distance: distanceToPosition,
          spamPlan,
        } = combatDecision


        // SPAM BOMBING: Special handling for multi-bomb sequences
        if (strategy.startsWith("SPAM_")) {

          // If at first position, START SPAMMING
          if (player.x === position.x && player.y === position.y) {

            // CRITICAL: Must validate escape path even for spam bombing!
            // Bot cannot spam continuously - must escape after each bomb
            // SPAM MODE: Use aggressive validation (allow risky timing-based escapes)
            const validation = validateBombAndEscape(
              position,
              enemy,
              map,
              bombs,
              bombers,
              myBomber,
              myUid,
              true, // aggressive = true for spam bombing
            )

            if (!validation.valid) {
              return null
            }

            trackDecision(player, "BOMB")

            // After bombing, MUST escape immediately
            // Bot will re-evaluate after escape and continue spam if still have bombs
            return createDecision("BOMB", {
              isEscape: true, // ✅ MUST escape after bombing!
              escapeAction: validation.escapePath.path[0],
              fullPath: validation.escapePath.path,
              mode: `spam_${spamPlan.strategy}`,
              spamSequence: spamPlan.positions, // Track spam sequence for continuation
              spamTarget: { x: enemy.x, y: enemy.y }, // Track enemy position for spam continuation
              targetEnemy: enemy, // Lock onto this specific enemy
            })
          }

          // Otherwise, move to first bomb position
          // SPAM SETUP: Use timing-based crossing for aggressive movement!
          const pathToSpam = findBestPath(
            map,
            player,
            [position],
            bombs,
            bombers,
            myUid,
            false, // not escaping yet
            true, // allowTimingCrossing - AGGRESSIVE for spam setup!
          )

          if (pathToSpam && pathToSpam.path.length > 0) {
            trackDecision(player, pathToSpam.path[0])

            return createDecision(pathToSpam.path[0], {
              mode: `spam_${spamPlan.strategy}_setup`,
            })
          }
        }

        // NORMAL BOMBING: Single bomb with escape
        // If we're already at the position, BOMB NOW
        if (player.x === position.x && player.y === position.y) {
          trackDecision(player, "BOMB")

          return createDecision("BOMB", {
            isEscape: true,
            escapeAction: escapePath ? escapePath[0] : null,
            fullPath: escapePath || [],
            fullPathCoordinates: escapeCoordinates,
            mode: `advanced_${strategy}`,
          })
        }

        // Otherwise, path to the position
        const pathToPosition = findSafePath(map, player, [position], bombs, bombers, myUid)

        if (pathToPosition && pathToPosition.path.length > 0) {
          trackDecision(player, pathToPosition.path[0])

          // CRITICAL: Don't return fullPath when pursuing enemy
          // Enemy can move → need to recalculate path each tick
          return createDecision(pathToPosition.path[0], {
            // NO fullPath - will recalculate next tick based on enemy's new position
            mode: `advanced_${strategy}_setup`,
          })
        } else {
        }
      }
    }

    return null
  }

  // PRIORITY PURSUIT MODE: Aggressively pursue enemies within range
  if (mode === "priority_pursuit") {
    for (const enemy of enemies) {
      const distanceToEnemy = manhattanDistance(enemy.x, enemy.y, player.x, player.y)

      if (distanceToEnemy > maxDistance) continue


      // Use range-based positions (not just adjacent) for flexible bombing
      const rangeBombingPositions = findRangeBasedBombingPositions(
        enemy,
        player,
        map,
        bombs,
        myBomber.explosionRange,
      )

      // CRITICAL: Check if ALREADY within bomb range (flexible - 1-range tiles)
      const withinRange = isWithinBombRange(
        player.x,
        player.y,
        enemy.x,
        enemy.y,
        myBomber.explosionRange,
      )

      if (withinRange) {

        const validation = validateBombAndEscape(
          player,
          enemy,
          map,
          bombs,
          bombers,
          myBomber,
          myUid,
        )

        if (validation.valid) {
          trackDecision(player, "BOMB")

          return createDecision("BOMB", {
            isEscape: true,
            escapeAction: validation.escapePath[0],
            fullPath: validation.escapePath,
            fullPathCoordinates: validation.escapeCoordinates || [],
            mode: "priority_pursuit_bomb",
          })
        } else {
        }
      } else if (rangeBombingPositions.length > 0) {
        // Not within range yet - path to range-based bombing positions
        if (rangeBombingPositions.length > 0) {
          const best = rangeBombingPositions[0]
        }
        const pathToEnemy = findSafePath(map, player, rangeBombingPositions, bombs, bombers, myUid)

        if (pathToEnemy && pathToEnemy.path.length > 0) {
          const finalPos = calculateFinalPosition(player, pathToEnemy.path)

          const validation = validateBombAndEscape(
            finalPos,
            enemy,
            map,
            bombs,
            bombers,
            myBomber,
            myUid,
          )

          if (validation.valid) {
            trackDecision(player, pathToEnemy.path[0])

            // CRITICAL: Don't use fullPath when chasing enemy
            // Enemy moves → need fresh path calculation each tick
            return createDecision(pathToEnemy.path[0], {
              // NO fullPath - recalculate each tick
              mode: "priority_pursuit",
            })
          } else if (validation.reason === "items") {
          }
        }
      }
    }
    return null
  }

  // DEFENSE MODE: Bomb nearby enemies (self-defense)
  if (mode === "defense") {
    for (const enemy of enemies) {
      // NEW: More flexible - bomb if enemy within range (1-2 tiles)
      const inRange = isWithinBombRange(
        player.x,
        player.y,
        enemy.x,
        enemy.y,
        myBomber.explosionRange,
      )
      if (!inRange) continue

      const distance = manhattanDistance(player.x, player.y, enemy.x, enemy.y)

      if (!canPlaceBomb(myBomber, bombs, myUid)) {
        continue
      }

      const bombPos = toBombGridCoords(myBomber.x, myBomber.y)

      const validation = validateBombAndEscape(bombPos, enemy, map, bombs, bombers, myBomber, myUid)

      if (validation.valid) {

        return createDecision("BOMB", {
          isEscape: true,
          escapeAction: validation.escapePath.path[0],
          fullPath: validation.escapePath.path,
          fullPathCoordinates: validation.escapePath.fullPathCoordinates || [],
          mode: "defense",
        })
      } else {
        if (validation.reason === "items") {
        } else if (validation.reason === "no_hit") {
        } else {
        }
      }
    }
    return null
  }

  // PURSUIT MODE: Chase enemies (FIGHT mode only)
  if (mode === "pursuit") {

    for (const enemy of enemies) {
      // Use range-based positions (not just adjacent) for flexible bombing
      const rangeBombingPositions = findRangeBasedBombingPositions(
        enemy,
        player,
        map,
        bombs,
        myBomber.explosionRange,
      )

      if (rangeBombingPositions.length === 0) {
        continue
      }

      if (rangeBombingPositions.length > 0) {
        const best = rangeBombingPositions[0]
      }
      const pathToPosition = findSafePath(map, player, rangeBombingPositions, bombs, bombers, myUid)
      if (!pathToPosition || pathToPosition.path.length === 0) continue

      if (!canPlaceBomb(myBomber, bombs, myUid)) {
        trackDecision(player, pathToPosition.path[0])
        // CRITICAL: No fullPath when chasing - enemy can move
        return createDecision(pathToPosition.path[0], {
          // NO fullPath - recalculate each tick
          mode: "pursuit",
        })
      }

      const finalPos = calculateFinalPosition(player, pathToPosition.path)

      const validation = validateBombAndEscape(
        finalPos,
        enemy,
        map,
        bombs,
        bombers,
        myBomber,
        myUid,
      )

      if (validation.valid) {
        trackDecision(player, pathToPosition.path[0])

        // CRITICAL: No fullPath when chasing - enemy can move
        return createDecision(pathToPosition.path[0], {
          // NO fullPath - recalculate each tick
          mode: "pursuit",
        })
      } else if (validation.reason === "items") {
      }
    }
    return null
  }

  // Default: no action
  return null
}
