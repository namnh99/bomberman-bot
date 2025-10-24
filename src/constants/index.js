export const GRID_SIZE = 40
export const STEP_DELAY = 20 // time tick on the server
export const BOT_SIZE = 35
export const BOMB_EXPLOSION_TIME = 5000 // Bombs explode after 5 seconds (5000ms)

export const DIRS = [
  [0, -1, "UP"],
  [0, 1, "DOWN"],
  [-1, 0, "LEFT"],
  [1, 0, "RIGHT"],
]

export const WALKABLE = [null, "B", "R", "S"]
export const BREAKABLE = ["C"]
export const BLOCKABLE_EXPLOSION = ["W", "C", "B", "R", "S"]

// Strategic values for different items
export const ITEM_VALUES = {
  S: 3.0, // Speed - very valuable for mobility and escaping
  R: 2.5, // Explosion Range - valuable for destroying more chests
  B: 2.0, // Bomb Count - valuable for offensive play
}

export const ITEM_PRIORITY_BIAS = 3 // Bot will prefer items if path is 3 steps longer than chest
