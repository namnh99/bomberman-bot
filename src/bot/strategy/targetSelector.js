import { GRID_SIZE, DIRS, ITEM_VALUES, ITEMS } from "../../utils/constants.js"
import { toGridCoords, posKey, inBounds, canExplosionReach } from "../../utils/gridUtils.js"
import { findUnsafeTiles } from "../pathfinding/dangerMap.js"

/**
 * Find all collectable items on the map (safe from bombs)
 */
export function findAllItems(map, bombs, allBombers) {
  const items = []
  const unsafeTiles = findUnsafeTiles(map, bombs, allBombers)

  for (let y = 0; y < map.length; y++) {
    for (let x = 0; x < map[y].length; x++) {
      const cell = map[y][x]
      if (ITEMS.includes(cell) && !unsafeTiles.has(posKey(x, y))) {
        items.push({ x, y, type: cell, value: ITEM_VALUES[cell] || 1 })
      }
    }
  }

  return items
}

/**
 * Find all chests on the map (safe from bombs)
 */
export function findAllChests(map, bombs, allBombers) {
  const targets = []
  const unsafeTiles = findUnsafeTiles(map, bombs, allBombers)

  for (let y = 0; y < map.length; y++) {
    for (let x = 0; x < map[y].length; x++) {
      if (map[y][x] === "C" && !unsafeTiles.has(posKey(x, y))) {
        targets.push({ x, y })
      }
    }
  }

  return targets
}

/**
 * Find all enemy bombers (alive, not me)
 */
export function findAllEnemies(map, bombs, allBombers, myUid) {
  const enemies = []

  for (const b of allBombers) {
    if (!b.isAlive) continue
    if (b.uid === myUid) continue

    const { x, y } = toGridCoords(b.x, b.y)
    enemies.push({ x, y, bomber: b })
  }

  return enemies
}

/**
 * Check if placing a bomb would destroy valuable items
 * Returns { willDestroyItems: boolean, items: Array }
 */
export function checkBombWouldDestroyItems(bx, by, map, range) {
  const affectedItems = []

  // SKIP bomb tile itself - bot will collect the item before bomb explodes
  // Only check items in explosion RANGE (not at bomb position)

  // Check explosion range in all 4 directions
  for (const [dx, dy] of DIRS) {
    for (let step = 1; step <= range; step++) {
      const nx = bx + dx * step
      const ny = by + dy * step

      if (!inBounds(nx, ny, map)) break

      const cell = map[ny][nx]

      // Explosion stops at walls/chests
      if (["C", "W"].includes(cell)) break

      if (ITEMS.includes(cell)) {
        affectedItems.push({ x: nx, y: ny, type: cell })
      }
    }
  }

  return {
    willDestroyItems: affectedItems.length > 0,
    items: affectedItems,
  }
}

/**
 * Count how many chests would be destroyed by a bomb
 * Returns { count: number, chests: Array }
 */
export function countChestsDestroyedByBomb(bx, by, map, range) {
  const affectedChests = []

  // Check bomb tile itself
  if (map[by] && map[by][bx] === "C") {
    affectedChests.push({ x: bx, y: by })
  }

  // Check explosion range in all 4 directions
  for (const [dx, dy] of DIRS) {
    for (let step = 1; step <= range; step++) {
      const nx = bx + dx * step
      const ny = by + dy * step

      if (!inBounds(nx, ny, map)) break

      const cell = map[ny][nx]

      // If we hit a chest, add it and stop
      if (cell === "C") {
        affectedChests.push({ x: nx, y: ny })
        break
      }

      // Explosion stops at walls
      if (cell === "W") break
    }
  }

  return {
    count: affectedChests.length,
    chests: affectedChests,
  }
}

/**
 * Check if a bomb at (bx,by) will hit an enemy at (ex,ey)
 */
export function willBombHitEnemy(bx, by, ex, ey, map, range) {
  return canExplosionReach(bx, by, ex, ey, map, range)
}
