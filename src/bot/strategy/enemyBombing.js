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
 * Find bombing positions within explosion range of enemy
 * FLEXIBLE: Can bomb from distance, not just adjacent!
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

      positions.push({
        x: bx,
        y: by,
        direction: dir,
        distanceFromPlayer,
        distanceFromEnemy,
        // Priority: closer to enemy = better (tighter trap)
        priority: distanceFromEnemy * 10 + distanceFromPlayer * 0.1,
      })

      // Take first valid position in this direction
      // (closest to enemy = best explosion zone coverage)
      break
    }
  }

  // Sort by priority (closer to enemy first, then closer to player)
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
      console.log(
        `   🎯 TRAP OPPORTUNITY! Target: Enemy | Trap Value: ${bestTrap.trapValue.toFixed(1)}`,
      )
      console.log(
        `   Will Kill: ${bestTrap.willKill ? "YES" : "NO"} | Blocked Routes: ${bestTrap.escapeRoutes}`,
      )

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
            console.log(
              `   ⚠️ Trap bomb would destroy ${validation.items.length} item(s) - skipping`,
            )
          } else {
            console.log(`   ❌ Trap validation failed: ${validation.reason}`)
          }
          return null
        }

        if (bombPos.x === player.x && bombPos.y === player.y) {
          console.log(`   💣 Trapping enemy with bomb!`)
          console.log(`🎯 DECISION: BOMB + ESCAPE (Enemy Trap)`)
          console.log("=".repeat(90) + "\n")
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
            console.log(`   Moving to trap position: ${pathToTrap.path.join(" → ")}`)
            console.log(`🎯 DECISION: Move to trap position`)
            console.log("=".repeat(90) + "\n")
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
    console.log(`\n🧠 PHASE: Advanced Combat (Predictive & Blocking)`)

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

        console.log(`   🎯 Advanced Combat: ${strategy}`)
        console.log(`   Position: [${position.x},${position.y}] (${distanceToPosition} steps away)`)

        // SPAM BOMBING: Special handling for multi-bomb sequences
        if (strategy.startsWith("SPAM_")) {
          console.log(`   💣💣💣 SPAM BOMBING MODE: ${spamPlan.strategy}`)
          console.log(`      Total bombs planned: ${spamPlan.totalBombs}`)
          console.log(
            `      Positions: ${spamPlan.positions.map((p) => `[${p.x},${p.y}]`).join(" → ")}`,
          )

          // If at first position, START SPAMMING
          if (player.x === position.x && player.y === position.y) {
            console.log(`   💣 START SPAM SEQUENCE!`)

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
              console.log(`   ❌ Spam bombing unsafe: ${validation.reason}`)
              console.log("=".repeat(90) + "\n")
              return null
            }

            console.log(
              `   ✅ Spam bomb validated with escape: ${validation.escapePath.path.join(" → ")}`,
            )
            console.log(`🎯 DECISION: BOMB (Spam ${spamPlan.strategy}) + ESCAPE`)
            console.log("=".repeat(90) + "\n")
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
          const pathToSpam = findSafePath(map, player, [position], bombs, bombers, myUid)

          if (pathToSpam && pathToSpam.path.length > 0) {
            console.log(`   🚶 Moving to spam position...`)
            console.log(`🎯 DECISION: MOVE (Spam Setup)`)
            console.log("=".repeat(90) + "\n")
            trackDecision(player, pathToSpam.path[0])

            return createDecision(pathToSpam.path[0], {
              mode: `spam_${spamPlan.strategy}_setup`,
            })
          }
        }

        // NORMAL BOMBING: Single bomb with escape
        // If we're already at the position, BOMB NOW
        if (player.x === position.x && player.y === position.y) {
          console.log(`   💣 ALREADY at combat position - BOMBING NOW!`)
          console.log(`🎯 DECISION: BOMB (${strategy})`)
          console.log("=".repeat(90) + "\n")
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
          console.log(
            `   🚶 Moving to combat position: ${pathToPosition.path.slice(0, 3).join(" → ")}`,
          )
          console.log(`🎯 DECISION: MOVE (Advanced Combat Setup - ${strategy})`)
          console.log("=".repeat(90) + "\n")
          trackDecision(player, pathToPosition.path[0])

          // CRITICAL: Don't return fullPath when pursuing enemy
          // Enemy can move → need to recalculate path each tick
          return createDecision(pathToPosition.path[0], {
            // NO fullPath - will recalculate next tick based on enemy's new position
            mode: `advanced_${strategy}_setup`,
          })
        } else {
          console.log(`   ❌ No safe path to combat position`)
        }
      }
    }

    console.log(`   ℹ️ No advanced combat opportunities found`)
    return null
  }

  // PRIORITY PURSUIT MODE: Aggressively pursue enemies within range
  if (mode === "priority_pursuit") {
    for (const enemy of enemies) {
      const distanceToEnemy = manhattanDistance(enemy.x, enemy.y, player.x, player.y)

      if (distanceToEnemy > maxDistance) continue

      console.log(`   🎯 Pursuing enemy at [${enemy.x},${enemy.y}] (distance: ${distanceToEnemy})`)

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
        console.log(
          `   💣 ALREADY within bomb range (${distanceToEnemy} tiles)! Attempting to bomb...`,
        )

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
          console.log(
            `   ✅ PRIORITY PURSUIT: Bombing enemy at ${distanceToEnemy} tiles distance NOW!`,
          )
          console.log(`🎯 DECISION: BOMB ENEMY (Range Attack - ${distanceToEnemy} tiles)`)
          console.log("=".repeat(90) + "\n")
          trackDecision(player, "BOMB")

          return createDecision("BOMB", {
            isEscape: true,
            escapeAction: validation.escapePath[0],
            fullPath: validation.escapePath,
            fullPathCoordinates: validation.escapeCoordinates || [],
            mode: "priority_pursuit_bomb",
          })
        } else {
          console.log(`   ❌ Cannot bomb: ${validation.reason}`)
        }
      } else if (rangeBombingPositions.length > 0) {
        // Not within range yet - path to range-based bombing positions
        console.log(
          `   📍 Found ${rangeBombingPositions.length} range-based bombing positions (1-${myBomber.explosionRange} tiles)`,
        )
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
            console.log(
              `   ✅ PRIORITY PURSUIT: Path to range bombing position found (${pathToEnemy.path.length} steps)`,
            )
            console.log(`      Can bomb and escape after reaching position`)
            console.log(`🎯 DECISION: PURSUE ENEMY (Priority - Range Based)`)
            console.log("=".repeat(90) + "\n")
            trackDecision(player, pathToEnemy.path[0])

            // CRITICAL: Don't use fullPath when chasing enemy
            // Enemy moves → need fresh path calculation each tick
            return createDecision(pathToEnemy.path[0], {
              // NO fullPath - recalculate each tick
              mode: "priority_pursuit",
            })
          } else if (validation.reason === "items") {
            console.log(`   ⚠️ Would destroy items, skipping this enemy`)
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
      console.log(
        `   ⚔️ Enemy within bomb range at [${enemy.x},${enemy.y}] (${distance} tiles) - DEFENSE MODE!`,
      )

      if (!canPlaceBomb(myBomber, bombs, myUid)) {
        console.log("   ⚠️ No bombs available for defense (all bombs already placed)")
        continue
      }

      const bombPos = toBombGridCoords(myBomber.x, myBomber.y)
      console.log(
        `   📍 Bot at grid [${player.x}, ${player.y}], bomb will be placed at [${bombPos.x}, ${bombPos.y}]`,
      )

      const validation = validateBombAndEscape(bombPos, enemy, map, bombs, bombers, myBomber, myUid)

      if (validation.valid) {
        console.log(`   ✅ DEFENSE BOMB: Can bomb adjacent enemy and escape!`)
        console.log(`      Escape: ${validation.escapePath.path.join(" → ")}`)

        return createDecision("BOMB", {
          isEscape: true,
          escapeAction: validation.escapePath.path[0],
          fullPath: validation.escapePath.path,
          fullPathCoordinates: validation.escapePath.fullPathCoordinates || [],
          mode: "defense",
        })
      } else {
        if (validation.reason === "items") {
          console.log(
            `   ⚠️ Bombing would destroy ${validation.items.length} item(s):`,
            validation.items.map((i) => `${i.type} at [${i.x},${i.y}]`).join(", "),
          )
          console.log("   ⚠️ Skipping enemy bomb to preserve items")
        } else if (validation.reason === "no_hit") {
          console.log("   ⚠️ Bomb here would not reach enemy")
        } else {
          console.log(`   ❌ Cannot escape after bombing - ${validation.reason}`)
        }
      }
    }
    return null
  }

  // PURSUIT MODE: Chase enemies (FIGHT mode only)
  if (mode === "pursuit") {
    console.log(`   🎯 FIGHT mode - actively pursuing enemies`)

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
        console.log(
          `   ℹ️ No valid range-based bombing positions for enemy at [${enemy.x},${enemy.y}]`,
        )
        continue
      }

      console.log(
        `   📍 Found ${rangeBombingPositions.length} range-based bombing positions (1-${myBomber.explosionRange} tiles)`,
      )
      const pathToPosition = findSafePath(map, player, rangeBombingPositions, bombs, bombers, myUid)
      if (!pathToPosition || pathToPosition.path.length === 0) continue

      if (!canPlaceBomb(myBomber, bombs, myUid)) {
        console.log("   ⚠️ No bombs available (all bombs already placed), chasing enemy")
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
        console.log(`   ✅ Plan: move to range bombing position and BOMB+ESCAPE`)
        console.log("   🎯 DECISION: MOVE (towards enemy - range based)")
        trackDecision(player, pathToPosition.path[0])

        // CRITICAL: No fullPath when chasing - enemy can move
        return createDecision(pathToPosition.path[0], {
          // NO fullPath - recalculate each tick
          mode: "pursuit",
        })
      } else if (validation.reason === "items") {
        console.log(`   ⚠️ Final bomb position would destroy items - skipping attack plan`)
      }
    }
    return null
  }

  // Default: no action
  return null
}
