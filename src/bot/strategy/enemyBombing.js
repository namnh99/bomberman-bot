import { DIRS, WALKABLE } from "../../utils/constants.js"
import { createFutureBomb, getBombWithGrid } from "../../utils/bombUtils.js"
import { validateBombSafety } from "./bombValidator.js"
import { willBombHitEnemy } from "./targetSelector.js"
import { toBombGridCoords, isAdjacent } from "../../utils/gridUtils.js"
import { findSafePath, findBestPath, findSafeTiles } from "../pathfinding/index.js"
import { findTrapOpportunities } from "./trapDetector.js"

/**
 * Evaluate if we should bomb an enemy from a given position
 * @param {Object} params - Parameters
 * @param {Object} params.bombPos - Position to place bomb {x, y}
 * @param {Object} params.enemyPos - Enemy position {x, y}
 * @param {Array} params.map - Game map
 * @param {Array} params.bombs - Active bombs
 * @param {Array} params.bombers - All bombers
 * @param {Object} params.myBomber - Current bomber
 * @param {string} params.myUid - Player UID
 * @param {Function} params.canBombAtPosition - Cooldown check function
 * @param {Function} params.checkBombWouldDestroyItems - Item check function
 * @returns {Object} { canBomb: boolean, reason: string, validation: Object }
 */
export function evaluateEnemyBombing({
  bombPos,
  enemyPos,
  map,
  bombs,
  bombers,
  myBomber,
  myUid,
  canBombAtPosition,
  checkBombWouldDestroyItems,
}) {
  // 1. Check cooldown
  if (!canBombAtPosition(bombPos.x, bombPos.y)) {
    return {
      canBomb: false,
      reason: "cooldown",
      message: `⏳ Bomb cooldown active at [${bombPos.x}, ${bombPos.y}]`,
    }
  }

  // 2. Check if bomb would hit enemy
  const willHit = willBombHitEnemy(
    bombPos.x,
    bombPos.y,
    enemyPos.x,
    enemyPos.y,
    map,
    myBomber.explosionRange,
  )

  if (!willHit) {
    return {
      canBomb: false,
      reason: "no_hit",
      message: `⚠️ Bomb at [${bombPos.x}, ${bombPos.y}] would not hit enemy at [${enemyPos.x}, ${enemyPos.y}]`,
    }
  }

  // 3. Check if bombing would destroy items
  const itemCheck = checkBombWouldDestroyItems(bombPos.x, bombPos.y, map, myBomber.explosionRange)

  if (itemCheck.willDestroyItems) {
    return {
      canBomb: false,
      reason: "destroy_items",
      message: `⚠️ Would destroy ${itemCheck.items.length} item(s): ${itemCheck.items.map((i) => `${i.type} at [${i.x},${i.y}]`).join(", ")}`,
    }
  }

  // 4. Validate bomb safety (escape path)
  const validation = validateBombSafety(bombPos, map, bombs, bombers, myBomber, myUid)

  if (!validation.canBomb) {
    return {
      canBomb: false,
      reason: validation.reason,
      message: `❌ BOMB VALIDATION FAILED: ${validation.reason}`,
      validation,
    }
  }

  // All checks passed!
  return {
    canBomb: true,
    reason: "safe",
    message: `✅ Can bomb enemy at [${enemyPos.x}, ${enemyPos.y}] and escape safely`,
    validation,
  }
}

/**
 * Find best position to bomb an enemy
 * @param {Object} params - Parameters
 * @param {Object} params.enemy - Enemy object {x, y, bomber}
 * @param {Object} params.player - Player position {x, y}
 * @param {Array} params.map - Game map
 * @param {Array} params.bombs - Active bombs
 * @param {Array} params.bombers - All bombers
 * @param {Object} params.myBomber - Current bomber
 * @param {string} params.myUid - Player UID
 * @param {Function} params.canBombAtPosition - Cooldown check
 * @param {Function} params.checkBombWouldDestroyItems - Item check
 * @returns {Object} { bombPosition: {x,y}, evaluation: Object } or null
 */
export function findBestEnemyBombPosition({
  enemy,
  player,
  map,
  bombs,
  bombers,
  myBomber,
  myUid,
  canBombAtPosition,
  checkBombWouldDestroyItems,
}) {
  const { x: ex, y: ey } = enemy

  // Generate candidate bomb positions (adjacent to enemy)
  const candidates = []

  for (const [dx, dy, dir] of DIRS) {
    const bombX = ex + dx
    const bombY = ey + dy

    // Check if position is walkable
    if (!map[bombY] || !WALKABLE.includes(map[bombY][bombX])) {
      continue
    }

    // Check if there's already a bomb there
    const hasBomb = bombs.some((b) => {
      const { gridX, gridY } = getBombWithGrid(b)
      return gridX === bombX && gridY === bombY
    })

    if (hasBomb) {
      continue
    }

    // Calculate distance from player
    const distance = Math.abs(bombX - player.x) + Math.abs(bombY - player.y)

    candidates.push({
      x: bombX,
      y: bombY,
      distance,
      direction: dir,
    })
  }

  if (candidates.length === 0) {
    return null
  }

  // Sort by distance (closest first)
  candidates.sort((a, b) => a.distance - b.distance)

  // Evaluate each candidate
  for (const candidate of candidates) {
    const evaluation = evaluateEnemyBombing({
      bombPos: candidate,
      enemyPos: enemy,
      map,
      bombs,
      bombers,
      myBomber,
      myUid,
      canBombAtPosition,
      checkBombWouldDestroyItems,
    })

    if (evaluation.canBomb) {
      return {
        bombPosition: candidate,
        evaluation,
      }
    }
  }

  // No valid bombing position found
  return null
}

/**
 * Check if we should bomb enemy immediately (at current position)
 * @param {Object} params - Parameters
 * @returns {Object} { shouldBomb: boolean, bombAction: Object } or null
 */
export function checkImmediateEnemyBomb({
  player,
  enemy,
  map,
  bombs,
  bombers,
  myBomber,
  myUid,
  canBombAtPosition,
  checkBombWouldDestroyItems,
}) {
  // Check if we're already at a good bombing position
  const evaluation = evaluateEnemyBombing({
    bombPos: player,
    enemyPos: enemy,
    map,
    bombs,
    bombers,
    myBomber,
    myUid,
    canBombAtPosition,
    checkBombWouldDestroyItems,
  })

  if (evaluation.canBomb) {
    return {
      shouldBomb: true,
      bombAction: {
        action: "BOMB",
        isEscape: true,
        escapeAction: evaluation.validation.escapeAction,
        fullPath: evaluation.validation.escapePath,
        fullPathCoordinates: evaluation.validation.escapeCoordinates || [],
      },
      evaluation,
    }
  }

  return null
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
  canBombAtPosition,
  recordBombPlacement,
  trackDecision,
  riskTolerance = 0.5,
  maxDistance = Infinity,
  checkBombWouldDestroyItems,
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

        if (!canBombAtPosition(bombPos.x, bombPos.y)) {
          console.log(`   ⏳ Trap position on cooldown, skipping`)
          return null
        }

        const itemCheck = checkBombWouldDestroyItems(
          bombPos.x,
          bombPos.y,
          map,
          myBomber.explosionRange,
        )
        if (itemCheck.willDestroyItems) {
          console.log(`   ⚠️ Trap bomb would destroy ${itemCheck.items.length} item(s) - skipping`)
          return null
        }

        const validation = validateBombSafety(bombPos, map, bombs, bombers, myBomber, myUid)

        if (validation.canBomb) {
          if (bombPos.x === player.x && bombPos.y === player.y) {
            console.log(`   💣 Trapping enemy with bomb!`)
            console.log(`🎯 DECISION: BOMB + ESCAPE (Enemy Trap)`)
            console.log("=".repeat(90) + "\n")
            trackDecision(player, "BOMB")
            recordBombPlacement(bombPos.x, bombPos.y)

            return {
              action: "BOMB",
              isEscape: true,
              escapeAction: validation.escapeAction,
              fullPath: validation.escapePath,
            }
          } else {
            const pathToTrap = findSafePath(map, player, [bombPos], bombs, bombers, myUid)
            if (pathToTrap && pathToTrap.path.length > 0) {
              console.log(`   Moving to trap position: ${pathToTrap.path.join(" → ")}`)
              console.log(`🎯 DECISION: Move to trap position`)
              console.log("=".repeat(90) + "\n")
              trackDecision(player, pathToTrap.path[0])
              return {
                action: pathToTrap.path[0],
                fullPath: pathToTrap.path,
                fullPathCoordinates: pathToTrap.fullPathCoordinates || [],
              }
            }
          }
        }
      }
    }
    return null
  }

  // PRIORITY PURSUIT MODE: Aggressively pursue enemies within range
  if (mode === "priority_pursuit") {
    for (const enemy of enemies) {
      const distance = Math.abs(enemy.x - player.x) + Math.abs(enemy.y - player.y)

      if (distance <= maxDistance) {
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

        if (adjacentTargets.length > 0) {
          const pathToEnemy = findSafePath(map, player, adjacentTargets, bombs, bombers, myUid)

          if (pathToEnemy && pathToEnemy.path.length > 0) {
            let fx = player.x
            let fy = player.y
            for (const step of pathToEnemy.path) {
              if (step === "LEFT") fx -= 1
              if (step === "RIGHT") fx += 1
              if (step === "UP") fy -= 1
              if (step === "DOWN") fy += 1
            }
            const finalPos = { x: fx, y: fy }

            const willHit = willBombHitEnemy(
              finalPos.x,
              finalPos.y,
              enemy.x,
              enemy.y,
              map,
              myBomber.explosionRange,
            )

            if (willHit) {
              const itemCheck = checkBombWouldDestroyItems(
                finalPos.x,
                finalPos.y,
                map,
                myBomber.explosionRange,
              )

              if (!itemCheck.willDestroyItems) {
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
                    console.log(
                      `   ✅ PRIORITY PURSUIT: Path to enemy found (${pathToEnemy.path.length} steps)`,
                    )
                    console.log(`      Can bomb and escape after reaching enemy`)
                    console.log(`🎯 DECISION: PURSUE ENEMY (Priority)`)
                    console.log("=".repeat(90) + "\n")
                    trackDecision(player, pathToEnemy.path[0])
                    return {
                      action: pathToEnemy.path[0],
                      fullPath: pathToEnemy.path,
                      isPursuit: true,
                    }
                  }
                }
              } else {
                console.log(`   ⚠️ Would destroy items, skipping this enemy`)
              }
            }
          }
        }
      }
    }
    return null
  }

  // DEFENSE MODE: Bomb adjacent enemies (self-defense)
  if (mode === "defense") {
    for (const enemy of enemies) {
      if (isAdjacent(enemy.x, enemy.y, player.x, player.y)) {
        console.log(`   ⚔️ Enemy adjacent at [${enemy.x},${enemy.y}] - DEFENSE MODE!`)

        if (myBomber.bombCount > 0) {
          const bombPos = toBombGridCoords(myBomber.x, myBomber.y)
          console.log(
            `   📍 Bot at grid [${player.x}, ${player.y}], bomb will be placed at [${bombPos.x}, ${bombPos.y}]`,
          )

          if (!canBombAtPosition(bombPos.x, bombPos.y)) {
            console.log("   ⏳ Bomb cooldown active, skipping enemy bomb")
            continue
          }

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
            console.log("   ⚠️ Skipping enemy bomb to preserve items")
            continue
          }

          const willHit = willBombHitEnemy(
            bombPos.x,
            bombPos.y,
            enemy.x,
            enemy.y,
            map,
            myBomber.explosionRange,
          )

          if (willHit) {
            const futureBombs = [
              ...bombs,
              createFutureBomb(bombPos.x, bombPos.y, myBomber.explosionRange, myBomber.uid),
            ]

            const futureSafeTiles = findSafeTiles(map, futureBombs, bombers, myBomber)
            if (futureSafeTiles.length > 0) {
              const escapeStartPos = { x: bombPos.x, y: bombPos.y }

              const escapePath = findBestPath(
                map,
                escapeStartPos,
                futureSafeTiles,
                futureBombs,
                bombers,
                myUid,
                true,
              )

              if (escapePath && escapePath.path.length > 0) {
                console.log(`   ✅ DEFENSE BOMB: Can bomb adjacent enemy and escape!`)
                console.log(`      Escape: ${escapePath.path.join(" → ")}`)

                recordBombPlacement(bombPos.x, bombPos.y)

                return {
                  action: "BOMB",
                  isEscape: true,
                  escapeAction: escapePath.path[0],
                  fullPath: escapePath.path,
                  fullPathCoordinates: escapePath.fullPathCoordinates || [],
                  isDefense: true,
                }
              } else {
                console.log(`   ❌ Cannot escape after bombing - skipping`)
              }
            }
          } else {
            console.log("   ⚠️ Bomb here would not reach enemy")
          }
        } else {
          console.log("   ⚠️ No bombs available for defense")
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

            const itemCheck = checkBombWouldDestroyItems(
              finalPos.x,
              finalPos.y,
              map,
              myBomber.explosionRange,
            )
            if (itemCheck.willDestroyItems) {
              console.log(`   ⚠️ Final bomb position would destroy items - skipping attack plan`)
              continue
            }

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
                  console.log(`   ✅ Plan: move to enemy-adjacent tile and BOMB+ESCAPE`)
                  console.log("   🎯 DECISION: MOVE (towards enemy)")
                  trackDecision(player, pathToAdj.path[0])
                  return {
                    action: pathToAdj.path[0],
                    fullPath: pathToAdj.path,
                    fullPathCoordinates: pathToAdj.fullPathCoordinates || [],
                  }
                }
              }
            }
          } else {
            console.log("   ⚠️ No bombs available, chasing enemy")
            if (pathToAdj.path.length > 0) {
              trackDecision(player, pathToAdj.path[0])
              return {
                action: pathToAdj.path[0],
                fullPath: pathToAdj.path,
                fullPathCoordinates: pathToAdj.fullPathCoordinates || [],
              }
            }
          }
        }
      }
    }
    return null
  }

  // Default: no action
  return null
}
