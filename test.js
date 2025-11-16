import { getRemainingBombs } from "./src/utils/bomberUtils.js"
import { getBombWithGrid } from "./src/utils/bombUtils.js"
import { DIRS } from "./src/utils/constants.js"
import { isWalkable, manhattanDistance } from "./src/utils/gridUtils.js"

export function findCrossBombingPositions(player, enemy, map, bombs, myBomber) {
  const { x: ex, y: ey } = enemy
  const range = myBomber.explosionRange
  const remainingBombs = getRemainingBombs(myBomber, bombs, myBomber.uid)

  console.log(`   ➕ Cross Bombing Analysis (SPAM MODE): ${remainingBombs} bombs available`)
  console.log(`      Enemy at [${ex},${ey}], Bomb Range: ${range}`)

  if (remainingBombs <= 0) {
    console.log(`      ❌ No bombs available`)
    return null
  }

  const crossPositions = []

  // SPAM ALL POSSIBLE DIRECTIONS
  for (const [dx, dy, dir] of DIRS) {
    let bestPosition = null

    // Tìm vị trí đặt bom trong direction này
    for (let step = 1; step <= range; step++) {
      const bx = ex + dx * step
      const by = ey + dy * step

      console.log(`         Checking [${bx},${by}] for direction ${dir}, value: ${map[by][bx]}`)

      if (!isWalkable(bx, by, map)) {
        // Blocked physically → không spam hướng này
        break
      }

      // Nếu có bomb sẵn thì bỏ qua
      const hasBomb = bombs.some((b) => {
        const { gridX, gridY } = getBombWithGrid(b)
        return gridX === bx && gridY === by
      })

      if (hasBomb) break

      const distanceFromPlayer = manhattanDistance(player.x, player.y, bx, by)

      const option = {
        x: bx,
        y: by,
        direction: dir,
        distanceFromPlayer,
        coverageScore: step,
        distanceToEnemy: step,
      }

      // Chọn ô gần enemy nhất
      if (!bestPosition || step < bestPosition.coverageScore) {
        bestPosition = option
      }
    }

    if (bestPosition) {
      crossPositions.push(bestPosition)
    }
  }

  if (crossPositions.length === 0) {
    console.log(`      ❌ No bombing positions available`)
    return null
  }

  // Sort: bomb gần enemy nhất → ưu tiên
  crossPositions.sort((a, b) => a.coverageScore - b.coverageScore)

  // SPAM MODE: đặt bom ở tất cả hướng có thể, trong giới hạn số bom
  const bombsToUse = Math.min(remainingBombs, crossPositions.length)

  const selectedPositions = crossPositions.slice(0, bombsToUse)

  console.log(`      🎯 SPAM BOMB MODE: Using ${bombsToUse} bombs`)
  console.log(
    `      Target positions: ${selectedPositions
      .map((p) => `[${p.x},${p.y}] (${p.direction})`)
      .join(" + ")}`,
  )

  return {
    positions: selectedPositions,
    totalBombs: selectedPositions.length,
    pattern: "CROSS",
  }
}

findCrossBombingPositions(
  { x: 14, y: 4 },
  {
    x: 13,
    y: 3,
    bomber: {
      x: 521,
      y: 121,
      speed: 1,
      type: 1,
      uid: "5brJ96AJpeNQue0VAAYO",
      orient: "DOWN",
      isAlive: true,
      size: 35,
      name: "Blast(1)",
      movable: true,
      protectCooldown: 0,
      score: 0,
      color: 1,
      explosionRange: 2,
      bombCount: 1,
      speedCount: 0,
    },
  },
  [
    ["W", "W", "W", "W", "W", "W", "W", "W", "W", "W", "W", "W", "W", "W", "W", "W"],
    ["W", null, null, null, null, null, null, null, null, null, null, null, null, null, null, "W"],
    ["W", null, "C", null, "W", null, "C", "W", "W", null, null, "W", null, null, null, "W"],
    ["W", null, null, null, null, null, null, null, null, null, null, null, null, null, null, "W"],
    ["W", null, "W", null, null, "W", "W", null, null, "W", "W", null, null, "W", null, "W"],
    ["W", null, null, null, null, null, null, null, null, null, null, null, null, null, null, "W"],
    ["W", null, null, null, "W", null, null, null, null, null, "W", "W", null, null, null, "W"],
    ["W", "W", "C", null, null, null, null, "W", null, null, null, null, null, null, "W", "W"],
    ["W", "W", "C", null, null, null, null, null, "W", null, null, null, null, null, "W", "W"],
    ["W", null, "C", null, "W", null, null, null, null, null, null, "W", null, null, null, "W"],
    ["W", null, null, null, "W", "C", "W", null, null, null, null, "W", null, null, null, "W"],
    ["W", null, "W", null, "C", null, "W", null, null, "W", null, null, null, "W", null, "W"],
    ["W", null, null, null, null, null, null, null, null, null, null, null, null, null, null, "W"],
    ["W", null, null, null, "W", null, "C", "W", "W", null, null, "W", null, null, null, "W"],
    ["W", null, null, null, null, null, null, null, null, null, null, null, null, null, null, "W"],
    ["W", "W", "W", "W", "W", "W", "W", "W", "W", "W", "W", "W", "W", "W", "W", "W"],
  ],
  [
    {
      x: 480,
      y: 120,
      uid: "J-JqEh1tlAZMxUESAAYG",
      ownerName: "Blast",
      id: 6487,
      lifeTime: 5000,
      createdAt: 1763326838959,
      explosionRange: 7,
      isExploded: false,
      walkable: false,
    },
    {
      x: 520,
      y: 80,
      uid: "J-JqEh1tlAZMxUESAAYG",
      ownerName: "Blast",
      id: 6488,
      lifeTime: 5000,
      createdAt: 1763326839591,
      explosionRange: 7,
      isExploded: false,
      walkable: false,
    },
  ],
  {
    x: 565,
    y: 163,
    speed: 3,
    type: 1,
    uid: "J-JqEh1tlAZMxUESAAYG",
    orient: "DOWN",
    isAlive: true,
    size: 35,
    name: "Blast",
    movable: true,
    protectCooldown: 0,
    score: 150,
    color: 0,
    explosionRange: 7,
    bombCount: 6,
    speedCount: 5,
  },
)
