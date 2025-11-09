import { GRID_SIZE } from "../utils/constants.js"
import {
  getBombWithGrid,
  getBombRange,
  getTimeUntilExplosion,
  isInBlastZone,
} from "../utils/bombUtils.js"

/**
 * Check if moving to next position is timing-safe
 * @param {Object} params - Parameters object
 * @param {number} params.nextX - Next X grid coordinate
 * @param {number} params.nextY - Next Y grid coordinate
 * @param {Array} params.bombs - Active bombs
 * @param {Array} params.bombers - All bombers
 * @param {Object} params.myBomber - Current bomber
 * @param {string} params.mode - "escape" or "follow"
 * @returns {Object} { isSafe: boolean, blockingBomb: Object|null }
 */
export function checkNextPositionTimingSafe({
  nextX,
  nextY,
  bombs,
  bombers,
  myBomber,
  mode = "follow",
}) {
  if (!bombs || bombs.length === 0) {
    return { isSafe: true, blockingBomb: null }
  }

  // console.log(
  //   `   🔍 ${mode === "escape" ? "Escape" : "Follow"} safety check: Moving to [${nextX},${nextY}]`,
  // )
  if (mode === "follow") {
    // console.log(`      Active bombs: ${bombs.length}`)
  }

  // Calculate time based on ACTUAL speed
  const timePerGrid = GRID_SIZE / myBomber.speed
  const alignmentTime = 340 // Alignment overhead
  const timeToWalk = timePerGrid + alignmentTime
  const SAFETY_BUFFER = 1580 // Safety buffer in ms

  let isSafe = true
  let blockingBomb = null

  for (const bomb of bombs) {
    const bombWithGrid = getBombWithGrid(bomb)
    const range = getBombRange(bomb, bombers)
    const timeLeft = getTimeUntilExplosion(bomb)

    // Check if next position is in THIS bomb's blast zone
    const inBlastZone = isInBlastZone(nextX, nextY, bomb, range)

    if (mode === "follow") {
      // console.log(
      //   `      💣 [${bombWithGrid.gridX},${bombWithGrid.gridY}] range=${range} explodes in ${timeLeft.toFixed(0)}ms`,
      // )
    }

    if (inBlastZone) {
      const timeNeeded = timeToWalk + SAFETY_BUFFER
      // console.log(
      //   `      ${mode === "follow" ? "   " : ""}💣 [${bombWithGrid.gridX},${bombWithGrid.gridY}] range=${range} explodes in ${timeLeft.toFixed(0)}ms (need ${timeNeeded.toFixed(0)}ms @ speed ${myBomber.speed})`,
      // )

      if (timeLeft < timeNeeded) {
        isSafe = false
        blockingBomb = {
          pos: { x: bombWithGrid.gridX, y: bombWithGrid.gridY },
          timeLeft,
          range,
          timeNeeded,
        }
        break // Found blocking bomb, no need to check others
      }
    }
  }

  return { isSafe, blockingBomb }
}
