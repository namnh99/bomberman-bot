import { DIRS, WALKABLE } from "../../utils/constants.js"
import { createFutureBomb, getBombWithGrid } from "../../utils/bombUtils.js"
import { canPlaceBomb } from "../../utils/bomberUtils.js"
import { willBombHitEnemy } from "./targetSelector.js"
import {
  toBombGridCoords,
  isAdjacent,
  calculateFinalPosition,
  manhattanDistance,
} from "../../utils/gridUtils.js"
import { findSafePath, findBestPath, findSafeTiles } from "../pathfinding/index.js"
import { findTrapOpportunities } from "./trapDetector.js"

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
 * @returns {Object} { valid: boolean, reason: string, escapePath: Object, items: Array }
 */
function validateBombAndEscape(bombPos, enemy, map, bombs, bombers, myBomber, myUid) {
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

  const escapePath = findBestPath(map, bombPos, futureSafeTiles, futureBombs, bombers, myUid, true)

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

  // PRIORITY PURSUIT MODE: Aggressively pursue enemies within range
  if (mode === "priority_pursuit") {
    for (const enemy of enemies) {
      const distance = manhattanDistance(enemy.x, enemy.y, player.x, player.y)

      if (distance > maxDistance) continue

      console.log(`   🎯 Pursuing enemy at [${enemy.x},${enemy.y}] (distance: ${distance})`)

      const adjacentTargets = []
      for (const [adx, ady] of DIRS) {
        const tx = enemy.x + adx
        const ty = enemy.y + ady
        if (map[ty] && WALKABLE.includes(map[ty][tx])) {
          const hasBomb = bombs.some((b) => {
            const { gridX, gridY } = getBombWithGrid(b)
            return gridX === tx && gridY === ty
          })
          if (!hasBomb) adjacentTargets.push({ x: tx, y: ty })
        }
      }

      // CRITICAL: Check if ALREADY at adjacent position (path = 0 steps)
      const alreadyAdjacent = isAdjacent(enemy.x, enemy.y, player.x, player.y)

      if (alreadyAdjacent) {
        console.log(`   💣 ALREADY adjacent to enemy! Attempting to bomb...`)

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
          console.log(`   ✅ PRIORITY PURSUIT: Bombing adjacent enemy NOW!`)
          console.log(`🎯 DECISION: BOMB ENEMY (Adjacent Attack)`)
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
      } else if (adjacentTargets.length > 0) {
        // Not adjacent yet - need to move
        const pathToEnemy = findSafePath(map, player, adjacentTargets, bombs, bombers, myUid)

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
              `   ✅ PRIORITY PURSUIT: Path to enemy found (${pathToEnemy.path.length} steps)`,
            )
            console.log(`      Can bomb and escape after reaching enemy`)
            console.log(`🎯 DECISION: PURSUE ENEMY (Priority)`)
            console.log("=".repeat(90) + "\n")
            trackDecision(player, pathToEnemy.path[0])

            return createDecision(pathToEnemy.path[0], {
              fullPath: pathToEnemy.path,
              fullPathCoordinates: pathToEnemy.fullPathCoordinates || [],
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

  // DEFENSE MODE: Bomb adjacent enemies (self-defense)
  if (mode === "defense") {
    for (const enemy of enemies) {
      if (!isAdjacent(enemy.x, enemy.y, player.x, player.y)) continue

      console.log(`   ⚔️ Enemy adjacent at [${enemy.x},${enemy.y}] - DEFENSE MODE!`)

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
      const adjacentTargets = []
      for (const [adx, ady] of DIRS) {
        const tx = enemy.x + adx
        const ty = enemy.y + ady
        if (map[ty] && WALKABLE.includes(map[ty][tx])) {
          const hasBomb = bombs.some((b) => {
            const { gridX, gridY } = getBombWithGrid(b)
            return gridX === tx && gridY === ty
          })
          if (!hasBomb) adjacentTargets.push({ x: tx, y: ty })
        }
      }

      if (adjacentTargets.length === 0) continue

      const pathToAdj = findSafePath(map, player, adjacentTargets, bombs, bombers, myUid)
      if (!pathToAdj || pathToAdj.path.length === 0) continue

      if (!canPlaceBomb(myBomber, bombs, myUid)) {
        console.log("   ⚠️ No bombs available (all bombs already placed), chasing enemy")
        trackDecision(player, pathToAdj.path[0])
        return createDecision(pathToAdj.path[0], {
          fullPath: pathToAdj.path,
          fullPathCoordinates: pathToAdj.fullPathCoordinates || [],
          mode: "pursuit",
        })
      }

      const finalPos = calculateFinalPosition(player, pathToAdj.path)

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
        console.log(`   ✅ Plan: move to enemy-adjacent tile and BOMB+ESCAPE`)
        console.log("   🎯 DECISION: MOVE (towards enemy)")
        trackDecision(player, pathToAdj.path[0])

        return createDecision(pathToAdj.path[0], {
          fullPath: pathToAdj.path,
          fullPathCoordinates: pathToAdj.fullPathCoordinates || [],
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
