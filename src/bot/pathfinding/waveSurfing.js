import { DIRS, WALKABLE, GRID_SIZE, STEP_DELAY } from "../../utils/constants.js"
import { manhattanDistance, posKey } from "../../utils/gridUtils.js"
import { getBombWithGrid, getBombRange, getTimeUntilExplosion } from "../../utils/bombUtils.js"
import { BLOCKABLE_EXPLOSION } from "../../utils/constants.js"

/**
 * FULL WAVE SURFING IMPLEMENTATION
 *
 * Wave Surfing is an advanced escape technique that treats bomb explosions as expanding waves.
 * Instead of just avoiding danger zones, the bot strategically positions itself just ahead of
 * blast wave edges, "surfing" the wave fronts to maximize safety and maneuverability.
 *
 * Key Concepts:
 * 1. Wave Expansion: Each bomb creates an expanding danger wave over time
 * 2. Wave Edges: The boundary between safe and unsafe zones at any given moment
 * 3. Surfing Corridor: Optimal positions that stay just ahead of wave edges
 * 4. Multi-Wave Navigation: Coordinating movement across multiple overlapping waves
 */

/**
 * Calculate blast wave expansion over time
 * Returns a timeline of how danger spreads from bomb origin
 *
 * @param {Object} bomb - Bomb with gridX, gridY, explosionRange, createdAt, lifeTime
 * @param {Array} map - Game map
 * @param {Array} bombers - All bombers
 * @returns {Map<string, Object>} Map of position keys to wave data
 */
export function calculateWaveExpansion(bomb, map, bombers) {
  const bombWithGrid = getBombWithGrid(bomb)
  const range = getBombRange(bomb, bombers)
  const timeUntilExplosion = getTimeUntilExplosion(bomb)

  // Each tile in blast zone has different timing based on explosion propagation
  // Explosion spreads from bomb center outward at ~40ms per tile
  const EXPLOSION_SPREAD_TIME = 40 // ms per tile

  const waveData = new Map()
  const { gridX, gridY } = bombWithGrid

  // Calculate wave timing for each direction
  for (const [dx, dy, dir] of DIRS) {
    for (let dist = 0; dist <= range; dist++) {
      const x = gridX + dx * dist
      const y = gridY + dy * dist

      // Check bounds
      if (y < 0 || y >= map.length || x < 0 || x >= map[0].length) break

      // Check if explosion is blocked
      const cell = map[y][x]
      if (dist > 0 && BLOCKABLE_EXPLOSION.includes(cell)) break

      const key = posKey(x, y)

      // Wave arrives at this tile after: bomb explodes + propagation delay
      const waveArrivalTime = timeUntilExplosion + dist * EXPLOSION_SPREAD_TIME
      const waveDuration = 500 // Explosion persists for 500ms
      const waveEndTime = waveArrivalTime + waveDuration

      // Store or merge wave data for this position
      if (waveData.has(key)) {
        const existing = waveData.get(key)
        // Multiple waves can hit same tile - track earliest and latest
        existing.waveArrivalTime = Math.min(existing.waveArrivalTime, waveArrivalTime)
        existing.waveEndTime = Math.max(existing.waveEndTime, waveEndTime)
      } else {
        waveData.set(key, {
          x,
          y,
          distanceFromBomb: dist,
          direction: dir,
          waveArrivalTime,
          waveEndTime,
          waveDuration,
          bombId: bomb.uid,
          bombPos: { x: gridX, y: gridY },
        })
      }
    }
  }

  return waveData
}

/**
 * Calculate combined wave expansion from multiple bombs
 * Merges overlapping waves and identifies complex wave patterns
 *
 * @param {Array} bombs - All active bombs
 * @param {Array} map - Game map
 * @param {Array} bombers - All bombers
 * @returns {Map<string, Object>} Combined wave data with multi-bomb analysis
 */
export function calculateMultiWaveExpansion(bombs, map, bombers) {
  const multiWaveData = new Map()

  // Calculate individual waves
  for (const bomb of bombs) {
    const waveData = calculateWaveExpansion(bomb, map, bombers)

    // Merge into multi-wave map
    for (const [key, data] of waveData.entries()) {
      if (multiWaveData.has(key)) {
        const existing = multiWaveData.get(key)

        // This tile is hit by multiple waves
        if (!existing.multipleWaves) {
          existing.multipleWaves = [existing]
        }
        existing.multipleWaves.push(data)

        // Update timing to earliest arrival and latest end
        existing.waveArrivalTime = Math.min(existing.waveArrivalTime, data.waveArrivalTime)
        existing.waveEndTime = Math.max(existing.waveEndTime, data.waveEndTime)
        existing.totalWaveDuration = existing.waveEndTime - existing.waveArrivalTime
      } else {
        multiWaveData.set(key, { ...data })
      }
    }
  }

  return multiWaveData
}

/**
 * Find wave edge positions - tiles that are just ahead of expanding blast waves
 * These are optimal surfing positions
 *
 * @param {Map} waveData - Wave expansion data
 * @param {Object} currentPos - Current position {x, y}
 * @param {number} currentSpeed - Bot's current speed
 * @param {Array} map - Game map
 * @returns {Array<Object>} Wave edge positions with surfing scores
 */
export function findWaveEdges(waveData, currentPos, currentSpeed, map) {
  const edges = []
  const now = Date.now()

  // Calculate time per grid movement (adjusted for actual measured timing)
  const timePerGridTheory = (GRID_SIZE / currentSpeed) * STEP_DELAY
  const timePerGridCell = timePerGridTheory * 1.85 // ADJUSTED: Network/server/alignment delay

  // Check all positions around dangerous zones
  for (const [key, wave] of waveData.entries()) {
    const { x, y, waveArrivalTime } = wave

    // Check adjacent tiles (potential surfing positions)
    for (const [dx, dy, dir] of DIRS) {
      const edgeX = x + dx
      const edgeY = y + dy
      const edgeKey = posKey(edgeX, edgeY)

      // Skip if this position is also in a wave
      if (waveData.has(edgeKey)) continue

      // Check bounds and walkability
      if (edgeY < 0 || edgeY >= map.length || edgeX < 0 || edgeX >= map[0].length) continue
      if (!WALKABLE.includes(map[edgeY][edgeX])) continue

      // Calculate if we can reach this edge position before wave arrives at neighbor
      const distanceToEdge = manhattanDistance(currentPos.x, currentPos.y, edgeX, edgeY)
      const timeToReachEdge = distanceToEdge * timePerGridCell
      const arrivalAtEdge = now + timeToReachEdge

      // Calculate surfing window - how long can we safely stay at this edge
      const surfingWindow = waveArrivalTime - arrivalAtEdge

      // Skip if we can't reach in time or window is too tight
      if (surfingWindow < 200) continue

      // Calculate surfing score - higher is better
      const surfingScore = calculateSurfingScore(
        edgeX,
        edgeY,
        currentPos,
        wave,
        surfingWindow,
        distanceToEdge,
        waveData,
        map,
      )

      edges.push({
        x: edgeX,
        y: edgeY,
        distanceToEdge,
        timeToReachEdge,
        surfingWindow,
        surfingScore,
        adjacentWave: wave,
        direction: dir,
        canEscape: true, // Will be validated later
      })
    }
  }

  // Deduplicate and sort by score
  const uniqueEdges = new Map()
  for (const edge of edges) {
    const key = posKey(edge.x, edge.y)
    if (!uniqueEdges.has(key) || uniqueEdges.get(key).surfingScore < edge.surfingScore) {
      uniqueEdges.set(key, edge)
    }
  }

  return Array.from(uniqueEdges.values()).sort((a, b) => b.surfingScore - a.surfingScore)
}

/**
 * Calculate surfing score for a wave edge position
 * Higher score = better surfing position
 *
 * Factors:
 * - Surfing window (time margin before wave arrives)
 * - Distance (closer is easier to reach)
 * - Multiple escape routes (avoid deadlocks)
 * - Strategic positioning (toward safe zones)
 */
function calculateSurfingScore(
  x,
  y,
  currentPos,
  adjacentWave,
  surfingWindow,
  distance,
  waveData,
  map,
) {
  let score = 0

  // 1. Surfing window - longer window = safer (0-5000 points)
  score += Math.min(5000, surfingWindow)

  // 2. Distance penalty - closer is better (subtract 0-1000 points)
  score -= distance * 50

  // 3. Escape route bonus - count safe adjacent tiles
  let escapeRoutes = 0
  for (const [dx, dy] of DIRS) {
    const nx = x + dx
    const ny = y + dy
    const nKey = posKey(nx, ny)

    if (ny >= 0 && ny < map.length && nx >= 0 && nx < map[0].length) {
      if (WALKABLE.includes(map[ny][nx]) && !waveData.has(nKey)) {
        escapeRoutes++
      }
    }
  }
  score += escapeRoutes * 500

  // 4. Direction bonus - prefer moving away from bomb
  const bombPos = adjacentWave.bombPos
  const distFromBomb = manhattanDistance(x, y, bombPos.x, bombPos.y)
  const currentDistFromBomb = manhattanDistance(currentPos.x, currentPos.y, bombPos.x, bombPos.y)

  if (distFromBomb > currentDistFromBomb) {
    score += 1000 // Bonus for moving away from bomb
  }

  return score
}

/**
 * Find optimal wave surfing path
 * This path strategically navigates wave edges to maximize safety
 *
 * @param {Object} start - Starting position {x, y}
 * @param {Array} bombs - All active bombs
 * @param {Array} map - Game map
 * @param {Array} bombers - All bombers
 * @param {string} myUid - Bot's UID
 * @returns {Object|null} Surfing path with metadata
 */
export function findWaveSurfingPath(start, bombs, map, bombers, myUid) {
  if (bombs.length === 0) return null

  const myBomber = bombers.find((b) => b.uid === myUid)
  const currentSpeed = myBomber?.speed || 1

  // Calculate multi-wave expansion
  const waveData = calculateMultiWaveExpansion(bombs, map, bombers)

  // Check if we're already in a wave
  const startKey = posKey(start.x, start.y)
  const inWave = waveData.has(startKey)


  if (!inWave) {
    // Not in immediate danger - find proactive surfing positions
    const edges = findWaveEdges(waveData, start, currentSpeed, map)


    if (edges.length === 0) {
      return null // No surfing opportunities
    }

    const bestEdge = edges[0]

    return {
      target: { x: bestEdge.x, y: bestEdge.y },
      strategy: "wave_edge_surfing",
      surfingWindow: bestEdge.surfingWindow,
      edges: edges.slice(0, 5), // Top 5 alternatives
      waveData,
    }
  } else {
    // Already in wave - find escape surfing path
    return findEscapeSurfingPath(start, waveData, currentSpeed, map, bombers, myUid)
  }
}

/**
 * Find escape path using wave surfing when already in danger
 * Navigates along wave edges to find safe exit
 *
 * @param {Object} start - Starting position
 * @param {Map} waveData - Wave expansion data
 * @param {number} currentSpeed - Bot's speed
 * @param {Array} map - Game map
 * @param {Array} bombers - All bombers
 * @param {string} myUid - Bot's UID
 * @returns {Object|null} Escape surfing path
 */
function findEscapeSurfingPath(start, waveData, currentSpeed, map, bombers, myUid) {
  const now = Date.now()
  const timePerGridTheory = (GRID_SIZE / currentSpeed) * STEP_DELAY
  const timePerGridCell = timePerGridTheory * 1.85 // ADJUSTED: Actual measured timing


  // BFS to find safe positions, preferring wave edge routes
  const queue = [{ x: start.x, y: start.y, steps: 0, path: [] }]
  const visited = new Set([posKey(start.x, start.y)])
  const bestEscapes = []

  while (queue.length > 0) {
    const current = queue.shift()

    // Stop if path is too long
    if (current.steps > 12) break

    const currentKey = posKey(current.x, current.y)
    const waveAtCurrent = waveData.get(currentKey)

    // Check if this position is safe (outside all waves)
    if (!waveAtCurrent) {
      const timeToReach = current.steps * timePerGridCell

      bestEscapes.push({
        position: { x: current.x, y: current.y },
        steps: current.steps,
        timeToReach,
        path: current.path,
        score: 10000 - current.steps * 100, // Prefer closer safe positions
      })

      // Continue searching for better options
      if (bestEscapes.length >= 5) break
    }

    // Explore neighbors
    for (const [dx, dy, dir] of DIRS) {
      const nx = current.x + dx
      const ny = current.y + dy
      const nKey = posKey(nx, ny)

      if (visited.has(nKey)) continue

      // Check bounds
      if (ny < 0 || ny >= map.length || nx < 0 || nx >= map[0].length) continue

      // Check walkability
      if (!WALKABLE.includes(map[ny][nx])) continue

      // Check timing - can we pass through safely?
      const stepsToNeighbor = current.steps + 1
      const timeToNeighbor = stepsToNeighbor * timePerGridCell
      const arrivalTime = now + timeToNeighbor

      const waveAtNeighbor = waveData.get(nKey)

      if (waveAtNeighbor) {
        // Position is in wave - check if we can cross before wave arrives
        if (arrivalTime + 200 >= waveAtNeighbor.waveArrivalTime) {
          continue // Too risky
        }
      }

      visited.add(nKey)
      queue.push({
        x: nx,
        y: ny,
        steps: stepsToNeighbor,
        path: [...current.path, dir],
      })
    }
  }

  if (bestEscapes.length === 0) {
    return null
  }

  // Sort by score
  bestEscapes.sort((a, b) => b.score - a.score)
  const best = bestEscapes[0]


  return {
    target: best.position,
    path: best.path,
    steps: best.steps,
    strategy: "escape_surfing",
    alternatives: bestEscapes.slice(1, 3),
  }
}

/**
 * Get immediate wave surfing direction
 * Returns best direction to surf wave edges RIGHT NOW
 *
 * @param {Object} currentPos - Current position {x, y}
 * @param {Array} bombs - All active bombs
 * @param {Array} map - Game map
 * @param {Array} bombers - All bombers
 * @param {string} myUid - Bot's UID
 * @returns {string|null} Direction to move (UP, DOWN, LEFT, RIGHT) or null
 */
export function getWaveSurfingDirection(currentPos, bombs, map, bombers, myUid) {
  const surfingPath = findWaveSurfingPath(currentPos, bombs, map, bombers, myUid)

  if (!surfingPath || !surfingPath.target) return null

  // Determine immediate direction to target
  const dx = surfingPath.target.x - currentPos.x
  const dy = surfingPath.target.y - currentPos.y

  // Prioritize axis with larger distance
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx > 0 ? "RIGHT" : "LEFT"
  } else if (Math.abs(dy) > 0) {
    return dy > 0 ? "DOWN" : "UP"
  }

  return null
}
