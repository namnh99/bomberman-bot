import { findBestPath } from "../pathfinding/pathFinder.js"
import { manhattanDistance, posKey } from "../../utils/gridUtils.js"

/**
 * Find optimal path that collects multiple targets in sequence
 * Uses greedy nearest-neighbor approach with pathfinding validation
 */
export function findMultiTargetPath(startPos, targets, map, bombs, bombers, myUid, maxTargets = 5) {
  if (!targets || targets.length === 0) return null

  const sequence = []
  const visited = new Set()
  let currentPos = { ...startPos }
  let totalPath = []
  let totalValue = 0

  // Start with closest target
  for (let i = 0; i < Math.min(targets.length, maxTargets); i++) {
    const nearestTarget = findNearestUnvisitedTarget(currentPos, targets, visited)

    if (!nearestTarget) break

    // Check if path exists to this target
    const path = findBestPath(map, currentPos, [nearestTarget], bombs, bombers, myUid)

    if (!path || path.path.length === 0) {
      // Can't reach this target, try next
      visited.add(posKey(nearestTarget.x, nearestTarget.y))
      continue
    }

    // Add to sequence
    sequence.push({
      target: nearestTarget,
      path: path.path,
      distance: path.path.length,
      value: nearestTarget.value || 1,
    })

    visited.add(posKey(nearestTarget.x, nearestTarget.y))
    totalPath = [...totalPath, ...path.path]
    totalValue += nearestTarget.value || 1

    // Update current position to target location
    currentPos = { x: nearestTarget.x, y: nearestTarget.y }
  }

  if (sequence.length === 0) return null

  return {
    sequence,
    totalPath,
    totalDistance: totalPath.length,
    totalValue,
    targetCount: sequence.length,
    efficiency: totalValue / Math.max(totalPath.length, 1),
  }
}

/**
 * Find nearest unvisited target
 */
function findNearestUnvisitedTarget(pos, targets, visited) {
  let nearest = null
  let minDistance = Infinity

  for (const target of targets) {
    const key = posKey(target.x, target.y)
    if (visited.has(key)) continue

    const distance = manhattanDistance(pos.x, pos.y, target.x, target.y)

    if (distance < minDistance) {
      minDistance = distance
      nearest = target
    }
  }

  return nearest
}

/**
 * Compare single-target vs multi-target strategies
 * Returns best approach
 */
export function compareSingleVsMultiTarget(startPos, targets, map, bombs, bombers, myUid) {
  // Single target: path to closest
  const singlePath = findBestPath(map, startPos, targets, bombs, bombers, myUid)

  // Multi target: path through multiple
  const multiPath = findMultiTargetPath(startPos, targets, map, bombs, bombers, myUid)

  if (!singlePath && !multiPath) return null
  if (!multiPath) return { strategy: "single", path: singlePath }
  if (!singlePath) return { strategy: "multi", path: multiPath }

  // Calculate efficiency
  const singleEfficiency = 1 / Math.max(singlePath.path.length, 1)
  const multiEfficiency = multiPath.efficiency

  // Prefer multi-target if significantly more efficient
  if (multiEfficiency > singleEfficiency * 1.3) {
    return {
      strategy: "multi",
      path: multiPath,
      reason: "better_efficiency",
      efficiency: multiEfficiency,
    }
  }

  // Prefer single-target if multi-path is too long
  if (multiPath.totalDistance > singlePath.path.length * 2) {
    return {
      strategy: "single",
      path: singlePath,
      reason: "shorter_path",
      efficiency: singleEfficiency,
    }
  }

  // Default to multi if it collects 2+ items
  if (multiPath.targetCount >= 2) {
    return {
      strategy: "multi",
      path: multiPath,
      reason: "multiple_targets",
      efficiency: multiEfficiency,
    }
  }

  return {
    strategy: "single",
    path: singlePath,
    reason: "default",
    efficiency: singleEfficiency,
  }
}
