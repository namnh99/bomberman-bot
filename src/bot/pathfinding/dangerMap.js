import { GRID_SIZE, DIRS, BLOCKABLE_EXPLOSION } from "../../utils/constants.js"
import { inBounds, posKey, toGridCoords } from "../../utils/gridUtils.js"

/**
 * Get all coordinates currently in an explosion radius (static danger map)
 * @param {Array} map - Game map
 * @param {Array} bombs - Array of bombs
 * @param {Array} allBombers - Array of all bombers for getting explosion ranges
 * @returns {Set} Set of unsafe coordinate keys "x,y"
 */
export function findUnsafeTiles(map, bombs = [], allBombers = []) {
  const unsafeCoords = new Set()
  const h = map.length
  const w = map[0].length

  for (const bomb of bombs) {
    if (bomb.isExploded) continue

    const owner = allBombers.find((b) => b.uid === bomb.uid)
    const range = owner ? owner.explosionRange : 2

    const { x: gridBombX, y: gridBombY } = toGridCoords(bomb.x, bomb.y)

    unsafeCoords.add(posKey(gridBombX, gridBombY))

    for (const [dx, dy] of DIRS) {
      for (let step = 1; step <= range; step++) {
        const nx = gridBombX + dx * step
        const ny = gridBombY + dy * step

        if (!inBounds(nx, ny, map)) break
        if (BLOCKABLE_EXPLOSION.includes(map[ny][nx])) break

        unsafeCoords.add(posKey(nx, ny))
      }
    }
  }

  return unsafeCoords
}

/**
 * Find all safe tiles (not in any explosion zone)
 * @param {Array} map - Game map
 * @param {Array} bombs - Array of bombs
 * @param {Array} allBombers - Array of all bombers
 * @returns {Array} Array of safe tile positions {x, y}
 */
export function findSafeTiles(map, bombs = [], allBombers = []) {
  const safeTiles = []
  const h = map.length
  const w = map[0].length
  const unsafeTiles = findUnsafeTiles(map, bombs, allBombers)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (map[y][x] === null && !unsafeTiles.has(posKey(x, y))) {
        safeTiles.push({ x, y })
      }
    }
  }

  return safeTiles
}

/**
 * Create a map of bomb tiles for quick lookup
 * @param {Array} bombs - Array of active bombs
 * @returns {Map} Map of "x,y" -> bomb object
 */
export function createBombTileMap(bombs) {
  const bombTiles = new Map()
  const activeBombs = bombs.filter((b) => !b.isExploded)

  activeBombs.forEach((b) => {
    const { x, y } = toGridCoords(b.x, b.y)
    bombTiles.set(posKey(x, y), b)
  })

  return bombTiles
}
