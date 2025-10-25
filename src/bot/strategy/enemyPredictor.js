import { DIRS, GRID_SIZE } from "../../utils/constants.js"
import { toGridCoords, isWalkable, manhattanDistance, posKey } from "../../utils/gridUtils.js"

/**
 * Predict enemy positions for next N ticks
 * Returns array of predicted positions with probability weights
 */
export function predictEnemyPositions(enemies, map, bombs, ticks = 3) {
  const predictions = []

  for (const enemy of enemies) {
    const { x: ex, y: ey, bomber } = enemy

    if (!bomber || !bomber.isAlive) continue

    const enemySpeed = bomber.speed || 1
    const maxSteps = Math.ceil(ticks * enemySpeed)

    const predictedPositions = simulateEnemyMovement(ex, ey, map, bombs, maxSteps, bomber)

    predictions.push({
      enemy,
      currentPos: { x: ex, y: ey },
      predictedPositions,
      maxReach: maxSteps,
    })
  }

  return predictions
}

/**
 * Simulate possible enemy movement using BFS
 * Returns all reachable positions with probability
 */
function simulateEnemyMovement(startX, startY, map, bombs, maxSteps, bomber) {
  const positions = new Map()
  const queue = [{ x: startX, y: startY, steps: 0, probability: 1.0 }]
  const visited = new Set()

  positions.set(posKey(startX, startY), { x: startX, y: startY, steps: 0, probability: 1.0 })

  while (queue.length > 0) {
    const { x, y, steps, probability } = queue.shift()

    if (steps >= maxSteps) continue

    const key = `${x},${y},${steps}`
    if (visited.has(key)) continue
    visited.add(key)

    // Enemy might move in any direction or stay
    const possibleMoves = [...DIRS, [0, 0, "STAY"]] // Include staying
    const moveProb = probability / possibleMoves.length

    for (const [dx, dy, dir] of possibleMoves) {
      const nx = x + dx
      const ny = y + dy

      if (dx !== 0 || dy !== 0) {
        // Check walkability for actual moves
        if (!isWalkable(nx, ny, map)) continue
      }

      const nextSteps = steps + 1
      const posKey = `${nx},${ny}`

      if (positions.has(posKey)) {
        // Update probability if higher path found
        const existing = positions.get(posKey)
        if (nextSteps < existing.steps || moveProb > existing.probability) {
          positions.set(posKey, {
            x: nx,
            y: ny,
            steps: nextSteps,
            probability: Math.max(existing.probability, moveProb),
          })
        }
      } else {
        positions.set(posKey, {
          x: nx,
          y: ny,
          steps: nextSteps,
          probability: moveProb,
        })
      }

      queue.push({ x: nx, y: ny, steps: nextSteps, probability: moveProb })
    }
  }

  return Array.from(positions.values()).sort((a, b) => b.probability - a.probability)
}

/**
 * Check if a path crosses predicted enemy positions
 * Returns danger score (0 = safe, 1 = very dangerous)
 */
export function evaluatePathDanger(path, enemyPredictions, myPos) {
  if (!path || path.length === 0) return 0

  let maxDanger = 0

  for (let step = 0; step < path.length; step++) {
    const pathPos = getPositionFromPath(myPos, path.slice(0, step + 1))

    for (const prediction of enemyPredictions) {
      for (const predicted of prediction.predictedPositions) {
        if (predicted.steps !== step) continue // Check matching timestep

        const distance = manhattanDistance(pathPos.x, pathPos.y, predicted.x, predicted.y)

        if (distance === 0) {
          // Direct collision
          maxDanger = Math.max(maxDanger, 1.0 * predicted.probability)
        } else if (distance === 1) {
          // Adjacent collision
          maxDanger = Math.max(maxDanger, 0.7 * predicted.probability)
        } else if (distance === 2) {
          // Near collision
          maxDanger = Math.max(maxDanger, 0.4 * predicted.probability)
        }
      }
    }
  }

  return maxDanger
}

/**
 * Convert path array to grid position
 */
function getPositionFromPath(startPos, path) {
  let { x, y } = startPos

  for (const action of path) {
    switch (action) {
      case "UP":
        y -= 1
        break
      case "DOWN":
        y += 1
        break
      case "LEFT":
        x -= 1
        break
      case "RIGHT":
        x += 1
        break
    }
  }

  return { x, y }
}
