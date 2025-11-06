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
 * @param {string} direction - The direction to move (UP/DOWN/LEFT/RIGHT)
 * @param {Object} myBomber - The bomber object
 * @param {Object} socket - Socket connection
 * @param {Object} gameContext - Game context with alignIntervalId
 * @returns {Promise} - Resolves when alignment is complete
 */
export function alignToGrid(direction, myBomber, socket, gameContext) {
  return new Promise((resolve) => {
    // CRITICAL: Check BOTH axes for comprehensive alignment
    const xOffset = myBomber.x % GRID_SIZE
    const yOffset = myBomber.y % GRID_SIZE
    const xAligned = xOffset <= GRID_SIZE - BOT_SIZE
    const yAligned = yOffset <= GRID_SIZE - BOT_SIZE

    console.log(
      `   🔧 Checking alignment: X-offset=${xOffset} (${xAligned ? "✓" : "✗"}), Y-offset=${yOffset} (${yAligned ? "✓" : "✗"})`,
    )

    // If BOTH axes are aligned, no alignment needed
    if (xAligned && yAligned) {
      console.log(`   ✅ Already aligned on both axes`)
      return resolve()
    }

    // Determine which axis needs alignment based on direction
    let moveOver = null
    let alignDirection = null

    if (direction === "UP" || direction === "DOWN") {
      // For vertical movement, ensure horizontal alignment (X-axis)
      if (!xAligned) {
        console.log(`   🔧 Aligning X-axis for ${direction} movement`)
        const offset = (GRID_SIZE - BOT_SIZE) / 2 // Target center position = 17.5

        // CRITICAL: Fix alignment direction logic
        if (xOffset < offset) {
          // Bot is too far LEFT, need to move RIGHT to center
          alignDirection = "RIGHT"
          moveOver = offset - xOffset
        } else {
          // Bot is too far RIGHT, need to move LEFT to center
          alignDirection = "LEFT"
          moveOver = xOffset - offset
        }
      } else {
        console.log(`   ⚠️ X-axis aligned but bot still stuck - this shouldn't happen`)
        return resolve() // Continue anyway
      }
    } else if (direction === "LEFT" || direction === "RIGHT") {
      // For horizontal movement, ensure vertical alignment (Y-axis)
      if (!yAligned) {
        console.log(`   🔧 Aligning Y-axis for ${direction} movement`)
        const offset = (GRID_SIZE - BOT_SIZE) / 2 // Target center position = 17.5

        // CRITICAL: Fix alignment direction logic
        if (yOffset < offset) {
          // Bot is too far UP, need to move DOWN to center
          alignDirection = "DOWN"
          moveOver = offset - yOffset
        } else {
          // Bot is too far DOWN, need to move UP to center
          alignDirection = "UP"
          moveOver = yOffset - offset
        }
      } else {
        console.log(`   ⚠️ Y-axis aligned but bot still stuck - this shouldn't happen`)
        return resolve() // Continue anyway
      }
    }

    if (moveOver && alignDirection) {
      const alignSteps = Math.ceil(moveOver / myBomber.speed)
      let stepsLeft = alignSteps
      console.log(
        `🔧 Aligning ${alignDirection} (${moveOver.toFixed(1)}px in ${alignSteps} steps, speed: ${myBomber.speed}) before moving ${direction}`,
      )

      // STUCK DETECTION for alignment
      const maxAlignTime = alignSteps * STEP_DELAY * 3 // Allow 3x expected time
      const alignTimeout = setTimeout(() => {
        if (gameContext.alignIntervalId) {
          console.log(`⚠️  Alignment TIMEOUT! Clearing interval and continuing...`)
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
