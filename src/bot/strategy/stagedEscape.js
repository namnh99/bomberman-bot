import { DIRS, WALKABLE, GRID_SIZE } from "../../utils/constants.js"
import { posKey, manhattanDistance } from "../../utils/gridUtils.js"
import { findUnsafeTiles } from "../pathfinding/dangerMap.js"
import { isTileSafeByTime } from "../pathfinding/safetyEvaluator.js"

/**
 * Find safe waiting position strategy:
 * When multiple bombs exist, find a position that is:
 * 1. Safe from the FASTEST bomb (will explode first)
 * 2. Still in danger from SLOWER bombs
 * 3. After fast bomb explodes, can escape from remaining bombs
 *
 * This allows "staged escape" - wait for first bomb to explode,
 * then escape from remaining bombs with better timing/terrain
 *
 * @returns {Object|null} { waitPosition: {x,y}, waitTime: ms, reason: string }
 */
export function findSafeWaitingPosition(myPos, map, bombs, bombers, myUid) {
  if (bombs.length < 2) {
    return null // Only useful with multiple bombs
  }

  const myBomber = bombers.find((b) => b.uid === myUid)
  const currentSpeed = myBomber?.speed || 1

  // Sort bombs by explosion time (fastest first)
  const sortedBombs = bombs
    .map((b) => ({
      ...b,
      gridX: Math.floor(b.x / GRID_SIZE),
      gridY: Math.floor(b.y / GRID_SIZE),
      timeRemaining: b.lifeTime - (Date.now() - b.createdAt),
    }))
    .sort((a, b) => a.timeRemaining - b.timeRemaining)

  const fastestBomb = sortedBombs[0]
  const remainingBombs = sortedBombs.slice(1)

  // Only consider if fastest bomb explodes soon (< 3.5s) but we have some time
  // Relaxed from 2.5s to allow more opportunities
  if (fastestBomb.timeRemaining > 3500 || fastestBomb.timeRemaining < 400) {
    return null
  }

  console.log(`   🔍 Staged Escape Analysis:`)
  console.log(
    `      Fastest bomb: [${fastestBomb.gridX}, ${fastestBomb.gridY}] explodes in ${(fastestBomb.timeRemaining / 1000).toFixed(1)}s`,
  )
  console.log(`      Remaining bombs: ${remainingBombs.length}`)
  remainingBombs.forEach((b, i) => {
    console.log(
      `         Bomb ${i + 1}: [${b.gridX}, ${b.gridY}] explodes in ${(b.timeRemaining / 1000).toFixed(1)}s`,
    )
  })

  // Find tiles that are:
  // 1. Safe from fastest bomb (outside its blast zone)
  // 2. Reachable in time
  // 3. Preferably still close enough to escape remaining bombs after

  const fastestBombOnly = [fastestBomb]
  const unsafeFromFastest = findUnsafeTiles(map, fastestBombOnly, bombers)
  const unsafeFromAll = findUnsafeTiles(map, bombs, bombers)

  console.log(`      🔍 Staged Escape: Checking if current position is safe...`)
  console.log(`         Current position: [${myPos.x}, ${myPos.y}]`)
  console.log(
    `         Fastest bomb: [${fastestBomb.gridX}, ${fastestBomb.gridY}] explodes in ${(fastestBomb.timeRemaining / 1000).toFixed(1)}s`,
  )

  // PRIORITY 1: Check if CURRENT position is already safe from fastest bomb
  const currentPosKey = posKey(myPos.x, myPos.y)
  const isCurrentPosSafeFromFastest = !unsafeFromFastest.has(currentPosKey)

  if (isCurrentPosSafeFromFastest) {
    // Current position is safe from fastest bomb!
    // Calculate how long we can wait here safely from remaining bombs
    let waitSafetyMargin = Infinity
    let isInRemainingBlastZones = unsafeFromAll.has(currentPosKey)

    for (const bomb of remainingBombs) {
      const bombDist = manhattanDistance(myPos, { x: bomb.gridX, y: bomb.gridY })

      if (bombDist <= bomb.explosionRange) {
        // Current position is in blast zone of a remaining bomb
        waitSafetyMargin = Math.min(waitSafetyMargin, bomb.timeRemaining)
      }
    }

    console.log(`      ✅ Current position is SAFE from fastest bomb!`)
    console.log(
      `         Wait safety margin from remaining bombs: ${waitSafetyMargin === Infinity ? "∞" : (waitSafetyMargin / 1000).toFixed(1) + "s"}`,
    )
    console.log(`         In remaining bombs blast zone: ${isInRemainingBlastZones ? "YES" : "NO"}`)

    // Only STAY if we're COMPLETELY safe (not in any blast zone)
    // If still in blast zone of remaining bombs, better to move to completely safe position
    if (!isInRemainingBlastZones) {
      console.log(`      🎯 Current position is COMPLETELY SAFE - will STAY here!`)
      return {
        waitPosition: { x: myPos.x, y: myPos.y },
        waitTime: fastestBomb.timeRemaining,
        waitSafetyMargin,
        isStayingInPlace: true,
        reason: `Stay at current position (completely safe), wait ${(fastestBomb.timeRemaining / 1000).toFixed(1)}s for fast bomb to explode`,
      }
    } else {
      // CRITICAL: Validate we can escape from current position after waiting
      const canEscapeLater = canEscapeAfterWaiting(myPos, remainingBombs, map, bombers, myUid)

      if (canEscapeLater && waitSafetyMargin > 1500) {
        // Can escape later AND have enough time - STAY here
        console.log(`      🎯 Current position has escape routes - will STAY and wait!`)
        return {
          waitPosition: { x: myPos.x, y: myPos.y },
          waitTime: fastestBomb.timeRemaining,
          waitSafetyMargin,
          isStayingInPlace: true,
          reason: `Stay at current position (safe from fast bomb, can escape later), wait ${(fastestBomb.timeRemaining / 1000).toFixed(1)}s`,
        }
      }

      console.log(
        `      ⚠️ Current position ${canEscapeLater ? "has escape routes but tight timing" : "has NO escape routes"} - should move to better position`,
      )
      // Don't return here - continue to search for better waiting position
    }
  }

  console.log(
    `      ⚠️ Current position NOT safe from fastest bomb - searching for safe waiting position...`,
  )

  // PRIORITY 2: Search for nearby safe waiting positions
  const candidates = []
  const maxRadius = 6 // Increased from 4 to search wider area

  console.log(`      🔍 Searching radius 1-${maxRadius}...`)
  console.log(`         Fastest bomb blast zone tiles: ${unsafeFromFastest.size}`)
  console.log(`         All bombs blast zone tiles: ${unsafeFromAll.size}`)

  let checkedCount = 0
  let walkableCount = 0
  let safeFromFastCount = 0
  let reachableCount = 0

  for (let radius = 1; radius <= maxRadius; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.abs(dx) + Math.abs(dy) !== radius) continue // Only check perimeter

        const checkX = myPos.x + dx
        const checkY = myPos.y + dy
        const key = posKey(checkX, checkY)

        checkedCount++

        // Must be in bounds
        if (checkY < 0 || checkY >= map.length || checkX < 0 || checkX >= map[0].length) {
          continue
        }

        // Must be walkable
        const cell = map[checkY][checkX]
        const isWalkable = WALKABLE.includes(cell)

        if (!isWalkable) {
          continue
        }

        walkableCount++

        // Must be SAFE from fastest bomb
        if (unsafeFromFastest.has(key)) {
          continue
        }

        safeFromFastCount++

        // Check if we can reach this position before fastest bomb explodes
        const distance = Math.abs(dx) + Math.abs(dy)
        const travelTime = distance * (680 / currentSpeed) + 340
        const safetyBuffer = 200 // Very small buffer - just enough to arrive safely

        if (travelTime + safetyBuffer > fastestBomb.timeRemaining) {
          continue // Can't reach in time
        }

        reachableCount++

        // DON'T use isTileSafeByTime here - it's too strict
        // We just need to be outside fastest bomb's blast zone
        // Timing with remaining bombs will be checked after

        // Calculate how long we can safely wait here
        let waitSafetyMargin = Infinity
        for (const bomb of remainingBombs) {
          const bombDist = manhattanDistance(
            { x: checkX, y: checkY },
            { x: bomb.gridX, y: bomb.gridY },
          )

          if (bombDist <= bomb.explosionRange) {
            // This position is in blast zone of a remaining bomb
            waitSafetyMargin = Math.min(waitSafetyMargin, bomb.timeRemaining - travelTime)
          }
        }

        // Prefer positions that:
        // 1. Are NOT in blast zone of remaining bombs (can wait indefinitely)
        // 2. Are close (less travel time)
        // 3. Have timing safety from remaining bombs
        // 4. CRITICAL: Have escape routes after waiting (prevent deadlocks)

        const isInRemainingBlastZones = unsafeFromAll.has(key)

        // CRITICAL: Validate that this waiting position will have escape routes
        // This prevents the bot from waiting in a position that becomes a deadlock
        const canEscapeLater = canEscapeAfterWaiting(
          { x: checkX, y: checkY },
          remainingBombs,
          map,
          bombers,
          myUid,
        )

        if (!canEscapeLater) {
          // Skip this position - it's a deadlock trap
          continue
        }

        const score = calculateWaitPositionScore(
          distance,
          fastestBomb.timeRemaining - travelTime,
          waitSafetyMargin,
          isInRemainingBlastZones,
        )

        candidates.push({
          x: checkX,
          y: checkY,
          distance,
          travelTime,
          timeUntilFastBombExplodes: fastestBomb.timeRemaining - travelTime,
          waitSafetyMargin,
          isInRemainingBlastZones,
          score,
        })
      }
    }
  }

  console.log(
    `      📊 Search stats: checked=${checkedCount}, walkable=${walkableCount}, safeFromFast=${safeFromFastCount}, reachable=${reachableCount}`,
  )
  console.log(`      📊 Found ${candidates.length} candidate waiting positions`)

  if (candidates.length === 0) {
    console.log(`      ❌ No safe waiting positions found (all blocked or unreachable)`)
    return null
  }

  // Sort by score (highest = best)
  candidates.sort((a, b) => b.score - a.score)

  // PRIORITIZE: Only accept positions that are COMPLETELY SAFE (not in any remaining blast zone)
  const completelySafeCandidates = candidates.filter((c) => !c.isInRemainingBlastZones)

  let best
  if (completelySafeCandidates.length > 0) {
    best = completelySafeCandidates[0]
    console.log(
      `      ✅ Found ${completelySafeCandidates.length} completely safe positions (outside all blast zones)`,
    )
  } else {
    // Fallback: Accept positions in remaining blast zones if we have enough time
    best = candidates[0]
    console.log(
      `      ⚠️ No completely safe positions found - using best available (still in blast zone)`,
    )
  }

  // Only use waiting strategy if:
  // 1. We have good time margin (> 500ms after reaching position)
  // 2. Position is completely safe OR we have at least 1.5s to wait safely

  const minWaitMargin = 500
  const isViable =
    best.timeUntilFastBombExplodes > minWaitMargin &&
    (!best.isInRemainingBlastZones || best.waitSafetyMargin > 1500)

  if (!isViable) {
    console.log(`      ❌ Best waiting position not viable enough`)
    console.log(`         Position: [${best.x}, ${best.y}]`)
    console.log(
      `         Time until fast bomb: ${(best.timeUntilFastBombExplodes / 1000).toFixed(1)}s`,
    )
    console.log(
      `         Wait safety margin: ${best.waitSafetyMargin === Infinity ? "∞" : (best.waitSafetyMargin / 1000).toFixed(1) + "s"}`,
    )
    return null
  }

  console.log(`      ✅ Safe waiting position found: [${best.x}, ${best.y}]`)
  console.log(
    `         Distance: ${best.distance} tiles (${(best.travelTime / 1000).toFixed(1)}s travel)`,
  )
  console.log(
    `         Time until fast bomb explodes after arrival: ${(best.timeUntilFastBombExplodes / 1000).toFixed(1)}s`,
  )
  console.log(
    `         In remaining blast zones: ${best.isInRemainingBlastZones ? "YES (must escape after)" : "NO (completely safe)"}`,
  )
  if (best.waitSafetyMargin !== Infinity) {
    console.log(`         Can wait safely for: ${(best.waitSafetyMargin / 1000).toFixed(1)}s`)
  }

  return {
    waitPosition: { x: best.x, y: best.y },
    waitTime: best.timeUntilFastBombExplodes,
    distance: best.distance,
    travelTime: best.travelTime,
    isInRemainingBlastZones: best.isInRemainingBlastZones,
    waitSafetyMargin: best.waitSafetyMargin,
    fastestBomb: {
      position: { x: fastestBomb.gridX, y: fastestBomb.gridY },
      timeRemaining: fastestBomb.timeRemaining,
    },
    remainingBombCount: remainingBombs.length,
    reason: best.isInRemainingBlastZones
      ? `Wait for fast bomb to explode, then escape from ${remainingBombs.length} remaining bomb(s)`
      : `Wait in completely safe zone while fast bomb explodes`,
  }
}

/**
 * Calculate score for waiting position
 * Higher = better
 */
function calculateWaitPositionScore(
  distance,
  timeAfterArrival,
  waitSafetyMargin,
  isInRemainingBlastZones,
) {
  let score = 0

  // Prefer closer positions (less risky travel)
  score += (10 - distance) * 100

  // Prefer more time after arrival (more margin for error)
  score += timeAfterArrival / 10

  // HEAVILY prefer positions completely outside remaining blast zones
  if (!isInRemainingBlastZones) {
    score += 10000 // Huge bonus
  } else {
    // If in blast zones, prefer longer wait safety margin
    if (waitSafetyMargin !== Infinity) {
      score += waitSafetyMargin / 10
    }
  }

  return score
}

/**
 * Validate that after waiting, we can still escape remaining bombs
 * CRITICAL: This prevents deadlock situations where bot waits in a position
 * that has no viable escape routes after the fast bomb explodes
 */
export function canEscapeAfterWaiting(waitPosition, remainingBombs, map, bombers, myUid) {
  // This will be called to validate if position will be escapable later
  // Check if from waitPosition, we have viable escape from remaining bombs

  const myBomber = bombers.find((b) => b.uid === myUid)
  const currentSpeed = myBomber?.speed || 1

  // Simple check: are we outside all remaining blast zones?
  const unsafeFromRemaining = findUnsafeTiles(map, remainingBombs, bombers)
  const key = posKey(waitPosition.x, waitPosition.y)

  if (!unsafeFromRemaining.has(key)) {
    return true // Already safe, no need to escape
  }

  // CRITICAL: Calculate distance to wait position for timing calculations
  const distanceToWaitPos =
    Math.abs(waitPosition.x - myBomber.x) + Math.abs(waitPosition.y - myBomber.y)

  let safeExitCount = 0
  for (const [dx, dy] of DIRS) {
    const neighbor = { x: waitPosition.x + dx, y: waitPosition.y + dy }

    // Check bounds
    if (
      neighbor.y < 0 ||
      neighbor.y >= map.length ||
      neighbor.x < 0 ||
      neighbor.x >= map[0].length
    ) {
      continue
    }

    // Check walkable
    const cell = map[neighbor.y][neighbor.x]
    if (!WALKABLE.includes(cell)) {
      continue
    }

    const nKey = posKey(neighbor.x, neighbor.y)

    // Check if this neighbor is safe or has timing margin
    if (!unsafeFromRemaining.has(nKey)) {
      safeExitCount++
    } else {
      // CRITICAL FIX: Account for time already spent traveling to wait position
      // Steps needed: (distanceToWaitPos) to reach wait position + 1 to reach neighbor
      const totalSteps = distanceToWaitPos + 1

      const isSafeByTime = isTileSafeByTime(
        neighbor.x,
        neighbor.y,
        totalSteps,
        remainingBombs,
        bombers,
        map,
        currentSpeed,
      )
      if (isSafeByTime) {
        safeExitCount++
      }
    }
  }

  // Need at least one safe exit to avoid deadlock
  return safeExitCount > 0
}
