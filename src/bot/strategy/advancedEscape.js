import { findSafeTiles } from "../pathfinding/dangerMap.js"
import { calculateDangerTimeline, findSafestTimedPath } from "../pathfinding/timingAnalyzer.js"
import { manhattanDistance, posKey } from "../../utils/gridUtils.js"
import { DIRS } from "../../utils/constants.js"

/**
 * Advanced escape strategy for multi-bomb scenarios
 * Considers bomb explosion chains and timing windows
 */
export function findAdvancedEscapePath(player, map, bombs, allBombers, myBomber) {
  console.log(`   🔍 Advanced Escape Analysis (${bombs.length} bombs active)`)

  // Get danger timeline
  const timeline = calculateDangerTimeline(bombs, allBombers, map)
  const now = Date.now()

  // Find all safe tiles
  const safeTiles = findSafeTiles(map, bombs, allBombers, myBomber)

  if (safeTiles.length === 0) {
    console.log(`   ❌ No safe tiles exist!`)
    return null
  }

  // Analyze each safe tile with timing
  const analyzedTiles = safeTiles.map((tile) => {
    const distance = manhattanDistance(player.x, player.y, tile.x, tile.y)
    const key = posKey(tile.x, tile.y)
    const danger = timeline.get(key)

    // Calculate if we can reach this tile in time
    const speed = myBomber.speed || 1
    const timeToReach = (distance * 40 * 100) / speed // milliseconds
    const arrivalTime = now + timeToReach

    let isSafe = true
    let urgency = 0

    if (danger) {
      // Check if we arrive during explosion
      if (arrivalTime >= danger.dangerStart && arrivalTime <= danger.dangerEnd) {
        isSafe = false
      }
      // Calculate urgency (how close to explosion)
      urgency = Math.max(0, danger.dangerStart - arrivalTime)
    }

    return {
      tile,
      distance,
      timeToReach,
      isSafe,
      urgency,
      score: isSafe ? distance - urgency / 1000 : Infinity,
    }
  })

  // Filter only safe tiles and sort by score
  const safest = analyzedTiles.filter((t) => t.isSafe).sort((a, b) => a.score - b.score)

  if (safest.length === 0) {
    console.log(`   ⚠️ No tiles reachable before explosions!`)
    return null
  }

  const bestTile = safest[0]
  console.log(
    `   ✅ Best escape tile: [${bestTile.tile.x},${bestTile.tile.y}] - ${bestTile.distance} steps away`,
  )

  // Use timed pathfinding for complex scenarios
  if (bombs.length >= 3) {
    const timedPath = findSafestTimedPath(
      player,
      bestTile.tile,
      map,
      bombs,
      allBombers,
      myBomber.speed || 1,
    )

    if (timedPath) {
      console.log(`   🎯 Using timed path (danger score: ${timedPath.dangerScore})`)
      return {
        path: timedPath.path,
        target: bestTile.tile,
        strategy: "timed",
      }
    }
  }

  return {
    target: bestTile.tile,
    distance: bestTile.distance,
    strategy: "nearest_safe",
  }
}

/**
 * Detect if we're in a bomb chain scenario
 * Returns bombs that will trigger chain reactions
 */
export function detectBombChains(bombs, allBombers, map) {
  const chains = []

  for (let i = 0; i < bombs.length; i++) {
    const bomb1 = bombs[i]
    if (bomb1.isExploded) continue

    const triggeredBombs = []

    for (let j = 0; j < bombs.length; j++) {
      if (i === j) continue

      const bomb2 = bombs[j]
      if (bomb2.isExploded) continue

      // Check if bomb1's explosion will trigger bomb2
      const willTrigger = checkBombTrigger(bomb1, bomb2, allBombers, map)

      if (willTrigger) {
        triggeredBombs.push(j)
      }
    }

    if (triggeredBombs.length > 0) {
      chains.push({
        triggerBomb: i,
        triggeredBombs,
        chainLength: triggeredBombs.length + 1,
      })
    }
  }

  return chains
}

/**
 * Check if bomb1's explosion will trigger bomb2
 */
function checkBombTrigger(bomb1, bomb2, allBombers, map) {
  const owner1 = allBombers.find((b) => b.uid === bomb1.uid)
  const range1 = owner1?.explosionRange || 2

  const b1x = Math.floor(bomb1.x / 40)
  const b1y = Math.floor(bomb1.y / 40)
  const b2x = Math.floor(bomb2.x / 40)
  const b2y = Math.floor(bomb2.y / 40)

  // Check if bomb2 is in bomb1's blast radius
  if (b1x === b2x && Math.abs(b1y - b2y) <= range1) {
    // Same column
    return true
  }
  if (b1y === b2y && Math.abs(b1x - b2x) <= range1) {
    // Same row
    return true
  }

  return false
}

/**
 * Find safe waiting position during chain reactions
 * Returns position that's safe from entire chain
 */
export function findChainSafePosition(player, chains, bombs, map, allBombers, myBomber) {
  if (chains.length === 0) return null

  const safeTiles = findSafeTiles(map, bombs, allBombers, myBomber)

  // Filter tiles that are safe from ALL bombs in chains
  const chainSafeTiles = safeTiles.filter((tile) => {
    for (const chain of chains) {
      const allChainBombs = [
        bombs[chain.triggerBomb],
        ...chain.triggeredBombs.map((idx) => bombs[idx]),
      ]

      for (const bomb of allChainBombs) {
        const owner = allBombers.find((b) => b.uid === bomb.uid)
        const range = owner?.explosionRange || 2

        const bx = Math.floor(bomb.x / 40)
        const by = Math.floor(bomb.y / 40)

        // Check if tile is in this bomb's range
        if (
          (tile.x === bx && Math.abs(tile.y - by) <= range) ||
          (tile.y === by && Math.abs(tile.x - bx) <= range)
        ) {
          return false
        }
      }
    }
    return true
  })

  if (chainSafeTiles.length === 0) return null

  // Find nearest chain-safe tile
  chainSafeTiles.sort(
    (a, b) =>
      manhattanDistance(player.x, player.y, a.x, a.y) -
      manhattanDistance(player.x, player.y, b.x, b.y),
  )

  return chainSafeTiles[0]
}
