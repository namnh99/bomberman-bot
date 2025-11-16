import { offset } from "../index.js"
import { STEP_DELAY, GRID_SIZE } from "../utils/constants.js"
import { getBomber } from "./gameState.js"

// Simple throttling to prevent spam
let lastMoveTime = 0
let lastDirection = null
const MIN_MOVE_INTERVAL = STEP_DELAY // Match server tick rate (17ms)

/**
 * Send a single move command to the server (direct emit with minimal throttling)
 */
export function sendMoveCommand(direction, socket) {
  if (!socket) {
    console.log("⚠️  No socket available for sendMoveCommand")
    return
  }

  const now = Date.now()
  const timeSinceLastMove = now - lastMoveTime

  // Throttle all moves to match server tick rate
  if (timeSinceLastMove < MIN_MOVE_INTERVAL) {
    return
  }

  socket.emit("move", { orient: direction })
  lastMoveTime = now
  lastDirection = direction
}

/**
 * Align bot to grid before moving in perpendicular direction
 * Only align if offset is greater than tolerance (5px)
 */
export function alignToGrid(direction, target, gameContext) {
  const { targetX, targetY } = target

  const getBomberFresh = () => getBomber(gameContext.currentState, gameContext.myUid)
  const myBomber = getBomberFresh()

  if (!myBomber) {
    console.log("⚠️  Bomber not found in alignToGrid")
    return Promise.resolve()
  }

  // console.log("🤖 Bot position:", myBomber.x, myBomber.y, "target:", targetX, targetY)

  return new Promise((resolve) => {
    // Calculate actual distance from target position
    const xDiff = Math.abs(myBomber.x - (targetX - offset)) % 40
    const yDiff = Math.abs(myBomber.y - (targetY - offset)) % 40

    const ALIGNMENT_TOLERANCE = 5
    // console.log(
    //   `   🔧 Checking alignment: X-diff = ${xDiff.toFixed(1)}px, Y-diff = ${yDiff.toFixed(1)}px (tolerance: ${ALIGNMENT_TOLERANCE}px)`,
    // )

    // Determine which axis needs alignment based on direction
    let moveOver = null
    let alignDirection = null

    if (direction === "UP" || direction === "DOWN") {
      // For vertical movement, check horizontal alignment (X-axis)
      if (xDiff > ALIGNMENT_TOLERANCE) {
        alignDirection = targetX > myBomber.x ? "RIGHT" : "LEFT"
        moveOver = xDiff + offset
        console.log(`   🔧 Need to align X-axis: ${moveOver.toFixed(1)}px ${alignDirection}`)
      } else {
        // console.log(`   ✅ X-axis aligned (diff: ${xDiff.toFixed(1)}px ≤ ${ALIGNMENT_TOLERANCE}px)`)
        return resolve()
      }
    } else if (direction === "LEFT" || direction === "RIGHT") {
      // For horizontal movement, check vertical alignment (Y-axis)
      if (yDiff > ALIGNMENT_TOLERANCE) {
        alignDirection = targetY > myBomber.y ? "DOWN" : "UP"
        moveOver = yDiff + offset
        console.log(`   🔧 Need to align Y-axis: ${moveOver.toFixed(1)}px ${alignDirection}`)
      } else {
        // console.log(`   ✅ Y-axis aligned (diff: ${yDiff.toFixed(1)}px ≤ ${ALIGNMENT_TOLERANCE}px)`)
        return resolve()
      }
    }

    if (moveOver && alignDirection) {
      const alignSteps = Math.ceil(moveOver / myBomber.speed)
      console.log(
        `🔧 Aligning ${alignDirection} (${moveOver.toFixed(1)}px in ${alignSteps} steps, speed: ${myBomber.speed}) before moving ${direction}`,
      )

      // STUCK DETECTION for alignment
      const maxAlignTime = alignSteps * STEP_DELAY * 3 // Allow 3x expected time
      const alignStartTime = Date.now()
      let lastCheckPos = { x: myBomber.x, y: myBomber.y } // Track last position for stuck detection

      // CRITICAL: Send alignment commands continuously (server requires this)
      // Queue will handle rate limiting and deduplication
      gameContext.alignIntervalId = setInterval(() => {
        const elapsed = Date.now() - alignStartTime
        if (elapsed > maxAlignTime) {
          // console.log(`⚠️  Alignment TIMEOUT! Continuing anyway...`)
          clearInterval(gameContext.alignIntervalId)
          gameContext.alignIntervalId = null
          return resolve()
        }

        // Re-check alignment - CRITICAL: Get fresh bomber data!
        const currentBomber = getBomberFresh()
        if (!currentBomber) {
          clearInterval(gameContext.alignIntervalId)
          gameContext.alignIntervalId = null
          return resolve()
        }

        const xDiff = Math.abs(currentBomber.x - (targetX - offset)) % 40
        const yDiff = Math.abs(currentBomber.y - (targetY - offset)) % 40

        const ALIGNMENT_TOLERANCE = 5
        const isAligned =
          direction === "UP" || direction === "DOWN"
            ? xDiff <= ALIGNMENT_TOLERANCE
            : yDiff <= ALIGNMENT_TOLERANCE

        if (isAligned) {
          // console.log(`   ✅ Alignment complete`)
          clearInterval(gameContext.alignIntervalId)
          gameContext.alignIntervalId = null
          return resolve()
        }

        // Send alignment command continuously
        if (gameContext.socket) {
          gameContext.socket.emit("move", { orient: alignDirection })
        }
        lastCheckPos = { x: currentBomber.x, y: currentBomber.y }
      }, STEP_DELAY)
    } else {
      return resolve()
    }
  })
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
