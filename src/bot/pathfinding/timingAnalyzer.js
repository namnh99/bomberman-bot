import { DIRS, BLOCKABLE_EXPLOSION, BOMB_EXPLOSION_TIME } from "../../utils/constants.js"
import { toGridCoords, inBounds, posKey } from "../../utils/gridUtils.js"

/**
 * Calculate when each tile will become dangerous and when it becomes safe again
 * Returns a map of tiles with their danger windows
 */
export function calculateDangerTimeline(bombs, allBombers, map) {
  const timeline = new Map() // posKey -> { dangerStart: timestamp, dangerEnd: timestamp }
  const now = Date.now()

  for (const bomb of bombs) {
    const owner = allBombers.find((b) => b.uid === bomb.uid)
    const range = owner?.explosionRange || 2
    const { x: bx, y: by } = toGridCoords(bomb.x, bomb.y)

    const bombCreatedAt = bomb.createdAt || now
    const bombLifeTime = bomb.lifeTime || BOMB_EXPLOSION_TIME
    const explosionTime = bombCreatedAt + bombLifeTime
    const dangerEndTime = explosionTime + 500 // Explosion lasts 500ms

    // Mark bomb tile and explosion range
    const affectedTiles = getExplosionPath(bx, by, range, map)

    for (const tile of affectedTiles) {
      const key = posKey(tile.x, tile.y)
      const existing = timeline.get(key)

      if (!existing || explosionTime < existing.dangerStart) {
        timeline.set(key, {
          dangerStart: explosionTime,
          dangerEnd: dangerEndTime,
          bombPos: { x: bx, y: by },
        })
      }
    }
  }

  return timeline
}

/**
 * Get all tiles affected by explosion
 */
function getExplosionPath(bx, by, range, map) {
  const tiles = [{ x: bx, y: by }]

  for (const [dx, dy] of DIRS) {
    for (let step = 1; step <= range; step++) {
      const nx = bx + dx * step
      const ny = by + dy * step

      if (!inBounds(nx, ny, map)) break

      tiles.push({ x: nx, y: ny })

      const cell = map[ny][nx]
      if (BLOCKABLE_EXPLOSION.includes(cell)) break
    }
  }

  return tiles
}

/**
 * Find optimal escape window - earliest time we can safely reach a tile
 */
export function findEscapeWindow(targetX, targetY, timeline, arrivalTime) {
  const key = posKey(targetX, targetY)
  const danger = timeline.get(key)

  if (!danger) {
    return { canReach: true, waitTime: 0, reason: "always_safe" }
  }

  // Check if we arrive before danger starts
  if (arrivalTime < danger.dangerStart) {
    return { canReach: true, waitTime: 0, reason: "arrive_before_explosion" }
  }

  // Check if we can wait for danger to pass
  const waitNeeded = danger.dangerEnd - arrivalTime
  if (waitNeeded > 0 && waitNeeded < 2000) {
    // Max 2s wait
    return { canReach: true, waitTime: waitNeeded, reason: "wait_for_explosion" }
  }

  return { canReach: false, waitTime: 0, reason: "cannot_avoid_explosion" }
}

/**
 * Advanced: Find path that minimizes time in danger zones
 */
export function findSafestTimedPath(start, target, map, bombs, allBombers, currentSpeed = 1) {
  const timeline = calculateDangerTimeline(bombs, allBombers, map)
  const GRID_SIZE = 40
  const STEP_DELAY = 100

  const queue = [
    {
      x: start.x,
      y: start.y,
      path: [],
      timeElapsed: 0,
      dangerScore: 0,
    },
  ]
  const visited = new Map() // posKey -> best time arrived

  while (queue.length > 0) {
    const current = queue.shift()

    // Check if reached target
    if (current.x === target.x && current.y === target.y) {
      return {
        path: current.path,
        dangerScore: current.dangerScore,
        timeElapsed: current.timeElapsed,
      }
    }

    const key = posKey(current.x, current.y)

    // Skip if we've visited this tile faster
    if (visited.has(key) && visited.get(key) <= current.timeElapsed) {
      continue
    }
    visited.set(key, current.timeElapsed)

    // Explore neighbors
    for (const [dx, dy, dir] of DIRS) {
      const nx = current.x + dx
      const ny = current.y + dy

      if (!inBounds(nx, ny, map)) continue

      const cell = map[ny][nx]
      if (![".", "B", "R", "S"].includes(cell)) continue

      const moveTime = (GRID_SIZE / currentSpeed) * STEP_DELAY
      const newTimeElapsed = current.timeElapsed + moveTime
      const arrivalTime = Date.now() + newTimeElapsed

      // Check danger at this tile
      const tileKey = posKey(nx, ny)
      const danger = timeline.get(tileKey)
      let dangerPenalty = 0

      if (danger) {
        if (arrivalTime >= danger.dangerStart && arrivalTime <= danger.dangerEnd) {
          dangerPenalty = 1000 // Heavy penalty for being in explosion
        } else if (
          arrivalTime < danger.dangerStart &&
          arrivalTime + moveTime > danger.dangerStart
        ) {
          dangerPenalty = 500 // Penalty for cutting it close
        }
      }

      queue.push({
        x: nx,
        y: ny,
        path: [...current.path, dir],
        timeElapsed: newTimeElapsed,
        dangerScore: current.dangerScore + dangerPenalty,
      })
    }

    // Sort queue by danger score + time (prioritize safest, fastest paths)
    queue.sort((a, b) => a.dangerScore + a.timeElapsed - (b.dangerScore + b.timeElapsed))
  }

  return null
}
