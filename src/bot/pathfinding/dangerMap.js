import { DIRS, BLOCKABLE_EXPLOSION, BREAKABLE, MAP_SIZE, ITEMS } from "../../utils/constants.js"
import { inBounds, posKey } from "../../utils/gridUtils.js"
import { getBombWithGrid, getBombRange } from "../../utils/bombUtils.js"

/**
 * Get all coordinates currently in an explosion radius (static danger map)
 * @param {Array} map - Game map
 * @param {Array} bombs - Array of bombs
 * @param {Array} allBombers - Array of all bombers for getting explosion ranges
 * @returns {Set} Set of unsafe coordinate keys "x,y"
 */
export function findUnsafeTiles(map, bombs = [], allBombers = []) {
  const unsafeCoords = new Set()

  for (const bomb of bombs) {
    const { gridX, gridY } = getBombWithGrid(bomb)
    const range = getBombRange(bomb, allBombers)

    unsafeCoords.add(posKey(gridX, gridY))

    for (const [dx, dy] of DIRS) {
      for (let step = 1; step <= range; step++) {
        const nx = gridX + dx * step
        const ny = gridY + dy * step

        if (!inBounds(nx, ny)) break
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
  const unsafeTiles = findUnsafeTiles(map, bombs, allBombers)

  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
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
  bombs.forEach((b) => {
    const { gridX, gridY } = getBombWithGrid(b)
    bombTiles.set(posKey(gridX, gridY), b)
  })

  return bombTiles
}
