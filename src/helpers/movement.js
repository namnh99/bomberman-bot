import { offset } from "../index.js"
import { STEP_DELAY, GRID_SIZE, BOT_SIZE } from "../utils/constants.js"
import { manhattanDistance } from "../utils/gridUtils.js"

/**
 * Send a single move command to the server
 */
export function sendMoveCommand(socket, direction) {
  // console.log(`   📤 Sending move command: ${direction}`)
  socket.emit("move", { orient: direction })
}

/**
 * Align bot to grid before moving in perpendicular direction
 * Only align if offset is greater than tolerance (5px)
 */
export function alignToGrid(direction, target, myBomber, socket, gameContext) {
  const { targetX, targetY } = target
  // console.log("bot position:", myBomber.x, myBomber.y, "target:", targetX, targetY)

  return new Promise((resolve) => {
    // Calculate actual distance from target position
    const xDiff = Math.abs(myBomber.x - (targetX - offset)) % 40
    const yDiff = Math.abs(myBomber.y - (targetY - offset)) % 40

    const ALIGNMENT_TOLERANCE = 5
    // console.log(
    //   `   🔧 Checking alignment: X-diff=${xDiff.toFixed(1)}px, Y-diff=${yDiff.toFixed(1)}px (tolerance: ${ALIGNMENT_TOLERANCE}px)`,
    // )

    // Determine which axis needs alignment based on direction
    let moveOver = null
    let alignDirection = null

    if (direction === "UP" || direction === "DOWN") {
      // For vertical movement, check horizontal alignment (X-axis)
      if (xDiff > ALIGNMENT_TOLERANCE) {
        alignDirection = targetX > myBomber.x ? "RIGHT" : "LEFT"
        moveOver = xDiff + offset
        // console.log(`   🔧 Need to align X-axis: ${moveOver.toFixed(1)}px ${alignDirection}`)
      } else {
        // console.log(`   ✅ X-axis aligned (diff: ${xDiff.toFixed(1)}px ≤ ${ALIGNMENT_TOLERANCE}px)`)
        return resolve()
      }
    } else if (direction === "LEFT" || direction === "RIGHT") {
      // For horizontal movement, check vertical alignment (Y-axis)
      if (yDiff > ALIGNMENT_TOLERANCE) {
        alignDirection = targetY > myBomber.y ? "DOWN" : "UP"
        moveOver = yDiff + offset
        // console.log(`   🔧 Need to align Y-axis: ${moveOver.toFixed(1)}px ${alignDirection}`)
      } else {
        // console.log(`   ✅ Y-axis aligned (diff: ${yDiff.toFixed(1)}px ≤ ${ALIGNMENT_TOLERANCE}px)`)
        return resolve()
      }
    }

    if (moveOver && alignDirection) {
      const alignSteps = Math.ceil(moveOver / myBomber.speed)
      let stepsLeft = alignSteps
      // console.log(
      //   `🔧 Aligning ${alignDirection} (${moveOver.toFixed(1)}px in ${alignSteps} steps, speed: ${myBomber.speed}) before moving ${direction}`,
      // )

      // STUCK DETECTION for alignment
      const maxAlignTime = alignSteps * STEP_DELAY * 3 // Allow 3x expected time
      const alignTimeout = setTimeout(() => {
        if (gameContext.alignIntervalId) {
          // console.log(`⚠️  Alignment TIMEOUT! Clearing interval and continuing...`)
          clearInterval(gameContext.alignIntervalId)
          gameContext.alignIntervalId = null
          resolve()
        }
      }, maxAlignTime)

      gameContext.alignIntervalId = setInterval(() => {
        if (stepsLeft > 0) {
          socket.emit("move", { orient: alignDirection })
          stepsLeft--
        } else {
          clearTimeout(alignTimeout)
          clearInterval(gameContext.alignIntervalId)
          gameContext.alignIntervalId = null
          return resolve()
        }
      }, STEP_DELAY - 10)
    } else {
      return resolve()
    }
  })
}

/**
 * Calculate stuck detection timeout based on speed
 */
export function calculateStuckTimeout(speed) {
  const timeToMoveOneGrid = (GRID_SIZE / speed) * STEP_DELAY
  const MAX_STUCK_TIME = Math.max(400, timeToMoveOneGrid * 2) // At least 400ms or 2x expected time
  const MAX_STUCK_CHECKS = Math.ceil(MAX_STUCK_TIME / STEP_DELAY)
  return { MAX_STUCK_TIME, MAX_STUCK_CHECKS }
}

/**
 * Check if bot is stuck (not moving)
 */
export function isStuck(currentPos, lastPos, threshold = 2) {
  const movedDistance = manhattanDistance(currentPos.x, currentPos.y, lastPos.x, lastPos.y)
  return movedDistance < threshold
}

/**
 * Calculate timing statistics for movement
 */
export function calculateMovementTiming(actualMoveTime, gridMoved, speed) {
  if (gridMoved > 0) {
    const timePerGrid = actualMoveTime / gridMoved
    const theoreticalTime = (GRID_SIZE / speed) * STEP_DELAY
    return {
      timePerGrid,
      theoreticalTime,
      difference: timePerGrid - theoreticalTime,
    }
  }
  return null
}
