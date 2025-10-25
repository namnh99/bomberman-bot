export const GRID_SIZE = 40
export const STEP_DELAY = 17 // time tick on the server
export const BOT_SIZE = 35
export const BOMB_EXPLOSION_TIME = 5000 // Bombs explode after 5 seconds (5000ms)
export const OSCILLATION_THRESHOLD = 2

export const DIRS = [
  [0, -1, "UP"],
  [0, 1, "DOWN"],
  [-1, 0, "LEFT"],
  [1, 0, "RIGHT"],
]

export const ITEMS = ["B", "R", "S"]
export const WALKABLE = [null, "B", "R", "S"]
export const BREAKABLE = ["C"]
export const BLOCKABLE_EXPLOSION = ["W", "C", "B", "R", "S"]

// Strategic values for different items
export const ITEM_VALUES = {
  S: 3.0, // Speed - very valuable for mobility and escaping
  R: 2.5, // Explosion Range - valuable for destroying more chests
  B: 2.0, // Bomb Count - valuable for offensive play
}

export const MAP_HEIGHT = 16
export const MAP_WIDTH = 16

export const ITEM_PRIORITY_BIAS = 10 // Bot will prefer items if path is 10 steps longer than chest
