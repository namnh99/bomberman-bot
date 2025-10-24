import { GRID_SIZE, DIRS, WALKABLE, BLOCKABLE_EXPLOSION } from "./constants.js"

/**
 * Convert pixel coordinates to grid coordinates
 */
export function toGridCoords(pixelX, pixelY) {
  return {
    x: Math.floor(pixelX / GRID_SIZE),
    y: Math.floor(pixelY / GRID_SIZE),
  }
}

/**
 * Convert grid coordinates to pixel coordinates
 */
export function toPixelCoords(gridX, gridY) {
  return {
    x: gridX * GRID_SIZE,
    y: gridY * GRID_SIZE,
  }
}

/**
 * Check if coordinates are within map bounds
 */
export function inBounds(x, y, map) {
  const h = map.length
  const w = map[0].length
  return x >= 0 && y >= 0 && x < w && y < h
}

/**
 * Check if a tile is walkable
 */
export function isWalkable(x, y, map) {
  if (!inBounds(x, y, map)) return false
  return WALKABLE.includes(map[y][x])
}

/**
 * Get all 4 adjacent positions
 */
export function getAdjacentPositions(x, y) {
  return DIRS.map(([dx, dy, dir]) => ({
    x: x + dx,
    y: y + dy,
    direction: dir,
    dx,
    dy,
  }))
}

/**
 * Calculate Manhattan distance between two points
 */
export function manhattanDistance(x1, y1, x2, y2) {
  return Math.abs(x1 - x2) + Math.abs(y1 - y2)
}

/**
 * Check if two positions are adjacent (distance = 1)
 */
export function isAdjacent(x1, y1, x2, y2) {
  return manhattanDistance(x1, y1, x2, y2) === 1
}

/**
 * Create a position key for Set/Map storage
 */
export function posKey(x, y) {
  return `${x},${y}`
}

/**
 * Check if explosion can reach a target from bomb position
 */
export function canExplosionReach(bombX, bombY, targetX, targetY, map, range) {
  if (bombX === targetX && bombY === targetY) return true

  for (const [dx, dy] of DIRS) {
    for (let step = 1; step <= range; step++) {
      const nx = bombX + dx * step
      const ny = bombY + dy * step

      if (!inBounds(nx, ny, map)) break
      if (BLOCKABLE_EXPLOSION.includes(map[ny][nx])) break
      if (nx === targetX && ny === targetY) return true
    }
  }

  return false
}
