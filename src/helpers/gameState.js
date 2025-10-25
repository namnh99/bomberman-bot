import { toGridCoords } from "../utils/gridUtils.js"
import { WALKABLE } from "../utils/constants.js"

/**
 * Track bomb positions for walkable detection
 * Map of "bombId" -> { gridX, gridY, bomberUid }
 */
export class BombTracker {
  constructor() {
    this.tracking = new Map()
  }

  add(bombId, gridX, gridY, bomberUid) {
    this.tracking.set(bombId, { gridX, gridY, bomberUid })
  }

  remove(bombId) {
    this.tracking.delete(bombId)
  }

  has(bombId) {
    return this.tracking.has(bombId)
  }

  get(bombId) {
    return this.tracking.get(bombId)
  }

  forEach(callback) {
    this.tracking.forEach(callback)
  }

  clear() {
    this.tracking.clear()
  }
}

/**
 * Check if a tile is walkable
 */
export function isWalkable(map, x, y, bombs, myUid) {
  // Out of bounds
  if (y < 0 || y >= map.length || x < 0 || x >= map[0].length) {
    return false
  }

  const tile = map[y][x]

  // Check if tile is walkable terrain
  if (!WALKABLE.includes(tile)) {
    return false
  }

  // Check if there's a bomb at this position
  const bomb = bombs.find((b) => {
    const { x: bombX, y: bombY } = toGridCoords(b.x, b.y)
    return bombX === x && bombY === y
  })

  // If there's a bomb, check if it's walkable
  if (bomb) {
    return bomb.walkable === true
  }

  return true
}

/**
 * Update bomber position in state
 */
export function updateBomberPosition(currentState, uid, x, y) {
  const bomber = currentState.bombers.find((b) => b.uid === uid)
  if (bomber) {
    bomber.x = x
    bomber.y = y
  }
}

/**
 * Update bomber attributes after item collection
 */
export function updateBomberAttributes(currentState, uid, data) {
  const bomber = currentState.bombers.find((b) => b?.uid === uid)
  if (bomber) {
    if (data.speed !== undefined) bomber.speed = data.speed
    if (data.explosionRange !== undefined) bomber.explosionRange = data.explosionRange
    if (data.bombCount !== undefined) bomber.bombCount = data.bombCount
  }
}

/**
 * Add a bomb to the state
 */
export function addBomb(currentState, bomb) {
  currentState.bombs.push(bomb)
}

/**
 * Remove a bomb from the state
 */
export function removeBomb(currentState, bombId) {
  const bombIndex = currentState.bombs.findIndex((b) => b.id === bombId)
  if (bombIndex !== -1) {
    currentState.bombs.splice(bombIndex, 1)
  }
}

/**
 * Update map after chest destruction
 */
export function updateMapAfterChestDestroy(currentState, chestX, chestY, item) {
  currentState.map[chestY][chestX] = item
}

/**
 * Update map after item collection
 */
export function updateMapAfterItemCollect(currentState, itemX, itemY) {
  currentState.map[itemY][itemX] = null
}

/**
 * Get bomber by UID
 */
export function getBomber(currentState, uid) {
  return currentState.bombers.find((b) => b.uid === uid)
}

/**
 * Check if bomber is on bomb tile
 */
export function isBomberOnBombTile(bomber, bombX, bombY) {
  const { x: bomberX, y: bomberY } = toGridCoords(bomber.x, bomber.y)
  return bomberX === bombX && bomberY === bombY
}
