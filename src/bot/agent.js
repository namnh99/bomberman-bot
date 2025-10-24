import { GRID_SIZE, DIRS, WALKABLE, BREAKABLE, ITEM_PRIORITY_BIAS } from "../utils/constants.js"
import { toGridCoords, posKey, isAdjacent, inBounds } from "../utils/gridUtils.js"
import { findBestPath } from "./pathfinding/index.js"
import { findSafeTiles } from "./pathfinding/dangerMap.js"
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
  predictEnemyPositions,
  evaluatePathDanger,
  findChainReactionOpportunities,
  isChainReactionWorthwhile,
  evaluateZoneControl,
  scoreEnemyThreat,
  findMostThreateningEnemy,
  shouldFightOrFlee,
  validateBombSafety,
  findMultiTargetPath,
  compareSingleVsMultiTarget,
} from "./strategy/index.js"

// Anti-oscillation: Track last position and decision
let lastPosition = null
let lastDecision = null
let decisionCount = 0

function trackDecision(player, action) {
  const key = posKey(player.x, player.y)
  lastPosition = key
  lastDecision = action
}

/**
 * Handle movement/bombing when a target is found
 */
function handleTarget(result, state, myUid) {
  const { map, bombs = [], bombers } = state
  const activeBombs = bombs.filter((b) => !b.isExploded)

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

      // Check if bombing would destroy valuable items
      const itemCheck = checkBombWouldDestroyItems(player.x, player.y, map, myBomber.explosionRange)
      if (itemCheck.willDestroyItems) {
        console.log(
          `   ⚠️ Bombing would destroy ${itemCheck.items.length} item(s):`,
          itemCheck.items.map((i) => `${i.type} at [${i.x},${i.y}]`).join(", "),
        )
        console.log("   🎯 DECISION: STAY (Avoiding item destruction)")
        console.log("=".repeat(60) + "\n")
        return { action: "STAY" }
      }

      const chestCount = countChestsDestroyedByBomb(
        player.x,
        player.y,
        map,
        myBomber.explosionRange,
      )
      console.log(
        `   💣 Bomb would destroy ${chestCount.count} chest(s):`,
        chestCount.chests.map((c) => `[${c.x},${c.y}]`).join(", "),
      )

      const futureBombs = [
        ...activeBombs,
        {
          x: player.x * GRID_SIZE,
          y: player.y * GRID_SIZE,
          explosionRange: myBomber.explosionRange,
        },
      ]
      const futureSafeTiles = findSafeTiles(state.map, futureBombs, bombers, myBomber)
      console.log(`   Future safe tiles: ${futureSafeTiles.length}`)

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
          console.log(`   ✅ Escape path: ${escapePath.path.join(" → ")}`)
          console.log(
            `🎯 DECISION: BOMB + ESCAPE (${chestCount.count} blocking chest${chestCount.count > 1 ? "s" : ""})`,
          )
          console.log("   💣 Bombing from", `[${player.x}, ${player.y}]`)
          console.log("   🏃 Escape action:", escapePath.path[0])
          console.log("=".repeat(60) + "\n")

          if (myBomber.bombCount) {
            return {
              action: "BOMB",
              escapeAction: escapePath.path[0],
              isEscape: true,
              fullPath: escapePath.path,
            }
          }
        } else {
          console.log(`   ❌ No escape path found`)
        }
      } else {
        console.log(`   ❌ No safe tiles after bombing`)
      }
    } else {
      console.log(`   Wall not adjacent, need to move closer first`)
    }
    console.log("🎯 DECISION: STAY (Not safe to bomb blocking chest)")
    console.log("=".repeat(60) + "\n")
    return { action: "STAY" }
  }

  // Move towards target
  if (result.path.length > 0) {
    console.log("🎯 DECISION: MOVE (towards target)")
    console.log("   Action:", result.path[0])
    console.log("=".repeat(60) + "\n")
    trackDecision(player, result.path[0])
    return { action: result.path[0] }
  }

  console.log("🎯 DECISION: STAY (No path)")
  console.log("=".repeat(60) + "\n")
  trackDecision(player, "STAY")
  return { action: "STAY" }
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

  // Anti-oscillation check
  const currentPosKey = posKey(player.x, player.y)
  if (lastPosition === currentPosKey && lastDecision) {
    decisionCount++
    if (decisionCount >= 2) {
      lastPosition = null
      decisionCount = 0
      return { action: lastDecision }
    }
  } else {
    decisionCount = 0
  }

  const activeBombs = bombs.filter((b) => !b.isExploded)
  console.log("💣 Active (non-exploded) Bombs:", activeBombs.length)
  if (activeBombs.length > 0) {
    console.log("   Bomb positions:")
    activeBombs.forEach((b, i) => {
      const { x, y } = toGridCoords(b.x, b.y)
      console.log(`   Bomb ${i + 1}: [${x}, ${y}] | owner: ${b.uid === myUid ? "ME" : b.uid}`)
    })
  }
  console.log("👥 Active Bombers:", bombers.filter((b) => b.isAlive).length)

  // PHASE 0: Game Context Analysis
  console.log("\n🔍 PHASE 0: Game Context Analysis")
  const enemies = findAllEnemies(map, activeBombs, bombers, myUid)
  const allItems = findAllItems(map, activeBombs, bombers)
  const allChests = findAllChests(map, activeBombs, bombers)

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
  const { isPlayerSafe, safeTiles } = checkSafety(map, player, activeBombs, bombers, myBomber)

  if (!isPlayerSafe) {
    const escapeResult = attemptEscape(map, player, activeBombs, bombers, myBomber, myUid)
    if (escapeResult) {
      trackDecision(player, escapeResult.action)
      return escapeResult
    }

    const emergencyResult = attemptEmergencyEscape(map, player, activeBombs, bombers, myBomber)
    if (emergencyResult) {
      trackDecision(player, emergencyResult.action)
      return emergencyResult
    }

    console.log("   ❌ No escape possible! Bracing for impact.")
    console.log("🎯 DECISION: STAY (No escape)")
    console.log("=".repeat(90) + "\n")
    trackDecision(player, "STAY")
    return { action: "STAY" }
  }

  // PHASE 1.5: Enemy Trap Detection (if aggressive)
  if (fightOrFlee === "fight" && enemies.length > 0 && myBomber.bombCount > 0) {
    console.log("\n🔍 PHASE 1.5: Enemy Trap Detection")
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

        // Validate bomb safety
        const validation = validateBombSafety(bombPos, map, activeBombs, bombers, myBomber, myUid)

        if (validation.canBomb) {
          // Check if we need to move to bomb position first
          if (bombPos.x === player.x && bombPos.y === player.y) {
            console.log(`   💣 Trapping enemy with bomb!`)
            console.log(`🎯 DECISION: BOMB + ESCAPE (Enemy Trap)`)
            console.log("=".repeat(90) + "\n")
            trackDecision(player, "BOMB")
            return {
              action: "BOMB",
              isEscape: true,
              escapeAction: validation.escapeAction,
              fullPath: validation.escapePath,
            }
          } else {
            // Path to bomb position
            const pathToTrap = findBestPath(map, player, [bombPos], activeBombs, bombers, myUid)
            if (pathToTrap && pathToTrap.path.length > 0) {
              console.log(`   Moving to trap position: ${pathToTrap.path.join(" → ")}`)
              console.log(`🎯 DECISION: Move to trap position`)
              console.log("=".repeat(90) + "\n")
              trackDecision(player, pathToTrap.path[0])
              return { action: pathToTrap.path[0] }
            }
          }
        }
      }
    }
  }

  // PHASE 1.6: Chain Reaction Detection
  if (activeBombs.length > 0 && myBomber.bombCount > 0 && riskTolerance > 0.5) {
    console.log("\n🔍 PHASE 1.6: Chain Reaction Detection")
    const chainOpportunities = findChainReactionOpportunities(
      player,
      map,
      activeBombs,
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
        const validation = validateBombSafety(bestChain, map, activeBombs, bombers, myBomber, myUid)

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

  // PHASE 2: Dynamic Item Prioritization
  console.log(`\n🔍 PHASE 2: Dynamic Item Prioritization`)
  const items = findAllItems(map, activeBombs, bombers)
  console.log(`   Items found: ${items.length}`)

  // Apply dynamic prioritization
  const prioritizedItems = items
    .map((item) => dynamicItemPriority(item, myBomber, enemies, player, gamePhase))
    .sort((a, b) => b.finalValue - a.finalValue)

  if (prioritizedItems.length > 0) {
    console.log(`   Top 3 prioritized items:`)
    prioritizedItems.slice(0, 3).forEach((pi, idx) => {
      console.log(
        `     ${idx + 1}. ${pi.item.type} at [${pi.item.x},${pi.item.y}] - Value: ${pi.finalValue.toFixed(1)} (base: ${pi.baseValue}, mult: ${pi.multiplier.toFixed(2)})`,
      )
    })
  }

  // Try multi-target path for items
  let itemResult = null
  if (prioritizedItems.length > 0) {
    const topItems = prioritizedItems.slice(0, 5).map((pi) => pi.item)
    const multiStrategy = compareSingleVsMultiTarget(
      player,
      topItems,
      map,
      activeBombs,
      bombers,
      myUid,
    )

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
  const chests = findAllChests(map, activeBombs, bombers)
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
    // Check if adjacent to a chest
    const adjacentChest = chests.find((c) => isAdjacent(c.x, c.y, player.x, player.y))

    if (adjacentChest) {
      console.log(`\n🔍 PHASE 3: Adjacent Chest Bombing`)
      console.log(`   🧱 Adjacent chest at [${adjacentChest.x}, ${adjacentChest.y}]`)

      const bombAlreadyHere = activeBombs.some((bomb) => {
        const { x, y } = toGridCoords(bomb.x, bomb.y)
        return x === player.x && y === player.y
      })

      if (bombAlreadyHere) {
        console.log(`   ⏸️  Bomb already exists at [${player.x}, ${player.y}], escaping instead`)
        const safeTiles = findSafeTiles(map, activeBombs, bombers, myBomber)
        if (safeTiles.length > 0) {
          const escapePath = findBestPath(map, player, safeTiles, activeBombs, bombers, myUid, true)
          if (escapePath && escapePath.path.length > 0) {
            return {
              action: escapePath.path[0],
              isEscape: true,
              fullPath: escapePath.path,
            }
          }
        }
        return { action: "STAY" }
      }

      if (myBomber.bombCount) {
        const itemCheck = checkBombWouldDestroyItems(
          player.x,
          player.y,
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
          const chestCount = countChestsDestroyedByBomb(
            player.x,
            player.y,
            map,
            myBomber.explosionRange,
          )
          console.log(
            `   💣 Bomb would destroy ${chestCount.count} chest(s):`,
            chestCount.chests.map((c) => `[${c.x},${c.y}]`).join(", "),
          )

          if (chestCount.count > 0) {
            const futureBombs = [
              ...activeBombs,
              {
                x: player.x * GRID_SIZE,
                y: player.y * GRID_SIZE,
                explosionRange: myBomber.explosionRange,
                uid: myBomber.uid,
              },
            ]
            const futureSafeTiles = findSafeTiles(map, futureBombs, bombers, myBomber)
            console.log(`   Future safe tiles after bombing: ${futureSafeTiles.length}`)

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
                console.log(`   ✅ Escape path found: ${escapePath.path.join(" → ")}`)
                console.log(
                  `🎯 DECISION: BOMB + ESCAPE (${chestCount.count} chest${chestCount.count > 1 ? "s" : ""})`,
                )
                console.log("   💣 Bombing from", `[${player.x}, ${player.y}]`)
                console.log("   🏃 Escape action:", escapePath.path[0])
                console.log("=".repeat(90) + "\n")

                return {
                  action: "BOMB",
                  isEscape: true,
                  escapeAction: escapePath.path[0],
                  fullPath: escapePath.path,
                }
              } else {
                console.log(`   ❌ No escape path found after bombing`)
              }
            } else {
              console.log(`   ❌ No safe tiles after bombing`)
            }
          } else {
            console.log(`   ⚠️ Bomb wouldn't actually hit any chests`)
          }
        }
      } else {
        console.log(`   ❌ No bombs available`)
      }

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
          const hasBomb = activeBombs.some((b) => {
            const { x, y } = toGridCoords(b.x, b.y)
            return x === adjX && y === adjY
          })

          if (hasBomb) {
            console.log(
              `   ⛔ Skipping adjacent target [${adjX},${adjY}] because it has an active bomb`,
            )
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

    console.log(`   Adjacent chest targets: ${adjacentTargetsWithScore.length}`)
    if (adjacentTargetsWithScore.length > 0) {
      console.log(
        `   Best position would destroy ${adjacentTargetsWithScore[0].chestCount} chest(s)`,
      )
    }

    if (adjacentTargetsWithScore.length) {
      const bestTargets = adjacentTargetsWithScore.filter(
        (t) => t.chestCount === adjacentTargetsWithScore[0].chestCount,
      )

      chestResult = findBestPath(map, player, bestTargets, activeBombs, bombers, myUid)
      if (chestResult) {
        console.log(
          `   ✅ Path to chest: ${chestResult.path.join(" → ")} (${chestResult.path.length} steps)`,
        )
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
    return handleTarget(chosenResult, state, myUid)
  }

  // PHASE 5.5: Enemy Pursuit
  console.log(`\n🔍 PHASE 5.5: Enemy Pursuit`)
  console.log(`   Enemies found: ${enemies.length}`)

  if (enemies.length > 0) {
    for (const enemy of enemies) {
      if (isAdjacent(enemy.x, enemy.y, player.x, player.y)) {
        console.log(`   Enemy adjacent at [${enemy.x},${enemy.y}]`)

        if (myBomber.bombCount) {
          const itemCheck = checkBombWouldDestroyItems(
            player.x,
            player.y,
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
            player.x,
            player.y,
            enemy.x,
            enemy.y,
            map,
            myBomber.explosionRange,
          )

          if (willHit) {
            const futureBombs = [
              ...activeBombs,
              {
                x: player.x * GRID_SIZE,
                y: player.y * GRID_SIZE,
                explosionRange: myBomber.explosionRange,
                uid: myBomber.uid,
              },
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
                console.log(
                  `   ✅ Can bomb enemy and escape: bomb + ${escapePath.path.join(" → ")}`,
                )
                return {
                  action: "BOMB",
                  isEscape: true,
                  escapeAction: escapePath.path[0],
                  fullPath: escapePath.path,
                }
              }
            }
          } else {
            console.log("   ⚠️ Bomb here would not reach enemy")
          }
        } else {
          console.log("   ⚠️ No bombs available to attack")
        }
      }

      // Try to path to enemy
      const adjacentTargets = []
      for (const [adx, ady] of DIRS) {
        const tx = enemy.x + adx
        const ty = enemy.y + ady
        if (map[ty] && WALKABLE.includes(map[ty][tx])) {
          const hasBomb = activeBombs.some((b) => {
            const { x, y } = toGridCoords(b.x, b.y)
            return x === tx && y === ty
          })
          if (!hasBomb) adjacentTargets.push({ x: tx, y: ty })
        }
      }

      if (adjacentTargets.length > 0) {
        const pathToAdj = findBestPath(map, player, adjacentTargets, activeBombs, bombers, myUid)
        if (pathToAdj && pathToAdj.path.length > 0) {
          if (myBomber.bombCount) {
            let fx = player.x
            let fy = player.y
            for (const step of pathToAdj.path) {
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
              const futureBombs = [
                ...activeBombs,
                {
                  x: finalPos.x * GRID_SIZE,
                  y: finalPos.y * GRID_SIZE,
                  explosionRange: myBomber.explosionRange,
                  uid: myBomber.uid,
                },
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
                    `   ✅ Plan: move to enemy-adjacent tile and BOMB+ESCAPE (path: ${pathToAdj.path.join(" → ")})`,
                  )
                  if (pathToAdj.path.length > 0) {
                    console.log("   🎯 DECISION: MOVE (towards enemy)")
                    trackDecision(player, pathToAdj.path[0])
                    return { action: pathToAdj.path[0] }
                  }
                }
              }
            }
          } else {
            console.log("   ⚠️ No bombs available, chasing enemy")
            trackDecision(player, pathToAdj.path[0])
            return { action: pathToAdj.path[0] }
          }
        }
      }
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
    if (inBounds(nx, ny, map)) {
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
    console.log(`   Trying to path to ${safeTiles.length} safe tiles...`)
    console.log(
      `   Sample safe tiles:`,
      safeTiles
        .slice(0, 5)
        .map((t) => `[${t.x},${t.y}]`)
        .join(", "),
    )

    // Filter out current position from safe tiles
    const otherSafeTiles = safeTiles.filter((t) => t.x !== player.x || t.y !== player.y)
    console.log(`   Safe tiles excluding current position: ${otherSafeTiles.length}`)

    if (otherSafeTiles.length > 0) {
      const explorePath = findBestPath(map, player, otherSafeTiles, activeBombs, bombers, myUid)
      if (explorePath && explorePath.path.length > 0) {
        console.log(`   ✅ Exploration path: ${explorePath.path.join(" → ")}`)
        console.log("🎯 DECISION: EXPLORE")
        console.log("   Action:", explorePath.path[0])
        console.log("=".repeat(90) + "\n")
        trackDecision(player, explorePath.path[0])
        return { action: explorePath.path[0] }
      } else {
        console.log(`   ❌ No exploration path found (likely trapped by walls/chests)`)
      }
    } else {
      // We're at the only safe tile - just pick any walkable adjacent direction
      console.log(`   ⚠️ Current position is the only safe tile, moving to adjacent walkable tile`)

      for (const [dx, dy, dir] of DIRS) {
        const nx = player.x + dx
        const ny = player.y + dy

        if (inBounds(nx, ny, map) && WALKABLE.includes(map[ny][nx])) {
          // Check if there's no bomb at this tile
          const hasBomb = activeBombs.some((b) => {
            const { x, y } = toGridCoords(b.x, b.y)
            return x === nx && y === ny
          })

          if (!hasBomb) {
            console.log(`   ✅ Moving ${dir} to [${nx},${ny}]`)
            console.log("🎯 DECISION: EXPLORE (adjacent move)")
            console.log("=".repeat(90) + "\n")
            trackDecision(player, dir)
            return { action: dir }
          }
        }
      }

      console.log(`   ❌ No walkable adjacent tiles without bombs`)
    }
  } else {
    console.log(`   ⚠️ No safe tiles available`)
  }

  // PHASE 6.5: Break out of isolation by bombing nearby obstacles
  if (myBomber.bombCount > 0) {
    console.log(`\n🔍 PHASE 6.5: Obstacle Breaking (Trapped Escape)`)

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

    console.log(`   Found ${nearbyObstacles.length} adjacent breakable obstacles`)

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

      console.log(`   Bombing here would destroy ${obstaclesInRange.length} obstacles`)
      console.log(`   Obstacle types:`, obstaclesInRange.map((o) => o.type).join(", "))

      // Only bomb if we can destroy obstacles and escape safely
      if (obstaclesInRange.length > 0) {
        const futureBombs = [
          ...activeBombs,
          {
            x: player.x * GRID_SIZE,
            y: player.y * GRID_SIZE,
            explosionRange: myBomber.explosionRange,
            uid: myBomber.uid,
          },
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
            console.log(`   ✅ Can bomb obstacles and escape!`)
            console.log(`🎯 DECISION: BOMB (Break Out) + ESCAPE`)
            console.log("=".repeat(90) + "\n")
            return {
              action: "BOMB",
              isEscape: true,
              escapeAction: escapePath.path[0],
              fullPath: escapePath.path,
            }
          } else {
            console.log(`   ⚠️ No escape path after bombing obstacles`)
          }
        } else {
          console.log(`   ⚠️ No safe tiles after bombing`)
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
