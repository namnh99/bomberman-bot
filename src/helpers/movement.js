import { STEP_DELAY, GRID_SIZE, BOT_SIZE } from "../utils/constants.js"

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
    let moveOver = null
    let alignDirection = null

    if (direction === "UP" || direction === "DOWN") {
      // Check horizontal alignment (X-axis)
      const xOffset = myBomber.x % GRID_SIZE
      console.log(`   🔧 Checking alignment X-offset: ${xOffset}`)

      // If offset <= 5 (GRID_SIZE - BOT_SIZE), bot is within grid cell - already aligned
      if (xOffset <= GRID_SIZE - BOT_SIZE) {
        console.log(`   ✅ Already aligned (offset ${xOffset} <= ${GRID_SIZE - BOT_SIZE})`)
        return resolve()
      }

      // Not aligned, need to move horizontally to get back into grid
      const offset = (GRID_SIZE - BOT_SIZE) / 2
      if (xOffset > BOT_SIZE / 2) {
        alignDirection = "RIGHT"
        moveOver = xOffset - offset
      } else {
        alignDirection = "LEFT"
        moveOver = GRID_SIZE - xOffset + offset
      }
    } else if (direction === "LEFT" || direction === "RIGHT") {
      // Check vertical alignment (Y-axis)
      const yOffset = myBomber.y % GRID_SIZE
      console.log(`   🔧 Checking alignment Y-offset: ${yOffset}`)

      // If offset <= 5 (GRID_SIZE - BOT_SIZE), bot is within grid cell - already aligned
      if (yOffset <= GRID_SIZE - BOT_SIZE) {
        console.log(`   ✅ Already aligned (offset ${yOffset} <= ${GRID_SIZE - BOT_SIZE})`)
        return resolve()
      }

      // Not aligned, need to move vertically to get back into grid
      const offset = (GRID_SIZE - BOT_SIZE) / 2
      if (yOffset > BOT_SIZE / 2) {
        alignDirection = "DOWN"
        moveOver = yOffset - offset
      } else {
        alignDirection = "UP"
        moveOver = GRID_SIZE - yOffset + offset
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
  const MAX_STUCK_TIME = Math.max(500, timeToMoveOneGrid * 2) // At least 500ms or 2x expected time
  const MAX_STUCK_CHECKS = Math.ceil(MAX_STUCK_TIME / STEP_DELAY)
  return { MAX_STUCK_TIME, MAX_STUCK_CHECKS }
}

/**
 * Check if bot is stuck (not moving)
 */
export function isStuck(currentPos, lastPos, threshold = 2) {
  const movedDistance = Math.abs(currentPos.x - lastPos.x) + Math.abs(currentPos.y - lastPos.y)
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
