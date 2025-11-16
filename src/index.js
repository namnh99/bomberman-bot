import "dotenv/config"
import socketManager from "./socket/SocketManager.js"
import { decideNextAction } from "./bot/agent.js"
import { STEP_DELAY, GRID_SIZE, DIRS } from "./utils/constants.js"
import { inBounds, toGridCoords } from "./utils/gridUtils.js"

// Import helpers
import { sendMoveCommand, alignToGrid, calculateMovementTiming } from "./helpers/movement.js"
import { BombTracker, isWalkable, getBomber } from "./helpers/gameState.js"
import { PathModeManager } from "./helpers/pathMode.js"
import { ManualControlManager, setupManualControl } from "./helpers/manualControl.js"
import { registerSocketHandlers } from "./handlers/socketHandlers.js"
import { checkNextPositionTimingSafe } from "./helpers/safetyCheck.js"

// ==================== INITIALIZATION ====================
export const offset = (GRID_SIZE - 35) / 2
const socket = socketManager.getSocket()

// Game context - shared state across all modules
const gameContext = {
  currentState: null,
  myUid: null,
  socket: socket, // Add socket to context for direct emit
  moveIntervalId: null,
  alignIntervalId: null,
  currentMove: null, // Track current movement context
  forceClearIntervals: () => {
    if (gameContext.moveIntervalId) {
      clearInterval(gameContext.moveIntervalId)
      gameContext.moveIntervalId = null
    }
    if (gameContext.alignIntervalId) {
      clearInterval(gameContext.alignIntervalId)
      gameContext.alignIntervalId = null
    }
    gameContext.currentMove = null
  },
}

// Managers
const bombTracker = new BombTracker()
const pathModeManager = new PathModeManager()
const manualControlManager = new ManualControlManager()

// ==================== CORE FUNCTIONS ====================

/**
 * Place a bomb
 */
function placeBomb() {
  socket.emit("place_bomb", {})
}

/**
 * Execute escape sequence after bomb placement is confirmed
 */
function executeEscapeAfterBomb(
  pathModeManager,
  escapeAction,
  isEscape,
  fullPath,
  fullPathCoordinates = [],
) {
  // After placing a bomb, start the full escape sequence if available
  if (isEscape && fullPath && fullPath.length > 0) {
    pathModeManager.startEscape(fullPath, fullPathCoordinates)
    const firstMove = pathModeManager.getNextEscapeMove()
    setTimeout(() => {
      smoothMove(firstMove, true)
    }, STEP_DELAY)
  } else if (isEscape && escapeAction && ["UP", "DOWN", "LEFT", "RIGHT"].includes(escapeAction)) {
    // Fallback: single escape move if no full path
    console.log(`🏃 Escaping after bomb: ${escapeAction}`)
    setTimeout(() => {
      smoothMove(escapeAction)
    }, STEP_DELAY)
  }
}

/**
 * Execute smooth movement to next grid cell
 * REFACTORED: No longer uses setInterval spam
 * Sends initial move command and tracks position via server updates
 */
async function smoothMove(direction) {
  // Track movement timing
  const movementStartTime = Date.now()

  // Clear any existing intervals and abort pending moves
  if (gameContext.moveIntervalId) {
    console.log(`⚠️  Canceling previous move to start new move: ${direction}`)
    clearInterval(gameContext.moveIntervalId)
    gameContext.moveIntervalId = null
  }
  if (gameContext.alignIntervalId) {
    console.log(`⚠️  Canceling alignment to start move: ${direction}`)
    clearInterval(gameContext.alignIntervalId)
    gameContext.alignIntervalId = null
  }

  const myBomber = getBomber(gameContext.currentState, gameContext.myUid)
  if (!myBomber) {
    console.log("⚠️  Bomber not found in current state")
    return
  }
  const movementStartGrid = { x: myBomber?.x, y: myBomber?.y }

  const { x: currentX, y: currentY } = toGridCoords(myBomber.x, myBomber.y)
  let nextGridX = currentX
  let nextGridY = currentY

  for (const [dx, dy, dir] of DIRS) {
    if (dir === direction) {
      nextGridX += dx
      nextGridY += dy
      break
    }
  }

  const targetPixelX = nextGridX * GRID_SIZE + offset
  const targetPixelY = nextGridY * GRID_SIZE + offset

  console.log(
    `🔄 Starting smooth move ${direction} from grid [${currentX}, ${currentY}] to grid [${nextGridX}, ${nextGridY}]`,
  )

  await alignToGrid(direction, { targetX: targetPixelX, targetY: targetPixelY }, gameContext)

  // CRITICAL: Get fresh bomber data after alignment!
  const myBomberAfterAlign = getBomber(gameContext.currentState, gameContext.myUid)
  if (!myBomberAfterAlign) {
    console.log("⚠️  Bomber not found after alignment")
    return
  }

  // console.log(
  //   "   🎯 Aligned to grid, proceeding with move..., bot pixel position:",
  //   myBomberAfterAlign.x,
  //   myBomberAfterAlign.y,
  // )

  const isTargetWalkable = isWalkable(
    gameContext.currentState.map,
    nextGridX,
    nextGridY,
    gameContext.currentState.bombs,
    gameContext.myUid,
  )

  if (!inBounds(nextGridX, nextGridY) || !isTargetWalkable) {
    console.log(
      `❌ BLOCKED: Cannot move ${direction} to [${nextGridX}, ${nextGridY}] - tile not walkable!`,
    )
    console.log(
      `   Tile value: ${gameContext.currentState.map[nextGridY]?.[nextGridX]} | In bounds: ${inBounds(nextGridX, nextGridY)} | Walkable: ${isTargetWalkable}`,
    )

    // Abort current path since next step is blocked
    if (pathModeManager.isEscaping()) {
      pathModeManager.abortEscape("Next tile blocked")
    }
    if (pathModeManager.isFollowing()) {
      pathModeManager.abortFollow("Next tile blocked")
    }

    gameContext.forceClearIntervals()
    makeDecision()
    return
  }

  // Store movement context for position tracking
  gameContext.currentMove = {
    direction,
    targetGrid: { x: nextGridX, y: nextGridY },
    targetPixel: { x: targetPixelX, y: targetPixelY },
    startTime: movementStartTime, // Total time (includes alignment)
    moveStartTime: Date.now(), // Pure movement time (after alignment)
    startGrid: movementStartGrid,
    startPixel: { x: myBomberAfterAlign.x, y: myBomberAfterAlign.y }, // Track starting pixel position (after alignment)
    lastPixel: { x: myBomberAfterAlign.x, y: myBomberAfterAlign.y }, // Track last known position
    lastMoveTime: Date.now(), // Track last time bot actually moved
    stuckCheckCount: 0, // Count consecutive stuck checks
    isEscaping: pathModeManager.isEscaping(),
    isFollowing: pathModeManager.isFollowing(),
  }

  // console.log(
  //   `🎯 Move ${direction} to [${nextGridX}, ${nextGridY}] | Speed: ${myBomber.speed}`,
  // )

  // Queue will handle rate limiting (17ms) and deduplication
  gameContext.moveIntervalId = setInterval(() => {
    const currentBomber = getBomber(gameContext.currentState, gameContext.myUid)
    if (!currentBomber) return

    const currentPixelX = currentBomber.x
    const currentPixelY = currentBomber.y

    // STUCK DETECTION: Check if bot is actually moving
    if (gameContext.currentMove) {
      const pixelsMoved =
        Math.abs(currentPixelX - gameContext.currentMove.lastPixel.x) +
        Math.abs(currentPixelY - gameContext.currentMove.lastPixel.y)

      const now = Date.now()
      const timeSinceLastMove = now - gameContext.currentMove.lastMoveTime

      if (pixelsMoved > 0) {
        // Bot moved - reset stuck detection
        gameContext.currentMove.lastPixel = { x: currentPixelX, y: currentPixelY }
        gameContext.currentMove.lastMoveTime = now
        gameContext.currentMove.stuckCheckCount = 0
      } else if (timeSinceLastMove > 200) {
        // Bot hasn't moved in 200ms - potentially stuck
        gameContext.currentMove.stuckCheckCount++

        if (gameContext.currentMove.stuckCheckCount >= 5) {
          // Stuck for 5 consecutive checks (~1 second) - abort move
          console.log(`⚠️ STUCK DETECTED: Bot hasn't moved in ${timeSinceLastMove}ms`)
          console.log(
            `   Position: [${Math.floor(currentPixelX / GRID_SIZE)}, ${Math.floor(currentPixelY / GRID_SIZE)}]`,
          )
          console.log(
            `   Target: [${gameContext.currentMove.targetGrid.x}, ${gameContext.currentMove.targetGrid.y}]`,
          )

          clearInterval(gameContext.moveIntervalId)
          gameContext.moveIntervalId = null

          // Abort paths and re-evaluate
          if (pathModeManager.isEscaping()) {
            pathModeManager.abortEscape("Movement stuck")
          }
          if (pathModeManager.isFollowing()) {
            pathModeManager.abortFollow("Movement stuck")
          }

          gameContext.currentMove = null
          makeDecision()
          return
        }
      }
    }

    // Check if reached target
    const distanceToTarget =
      direction === "UP" || direction === "DOWN"
        ? Math.abs(currentPixelY - targetPixelY)
        : Math.abs(currentPixelX - targetPixelX)

    if (distanceToTarget <= myBomber.speed) {
      clearInterval(gameContext.moveIntervalId)
      gameContext.moveIntervalId = null
      handleMoveComplete()
    } else {
      sendMoveCommand(direction, socket)
    }
  }, STEP_DELAY)
}

/**
 * Handle move completion - called when bot reaches target position
 * This is triggered by position tracking in smoothMove
 */
function handleMoveComplete() {
  if (!gameContext.currentMove) return

  const { direction, startTime, moveStartTime, startGrid, startPixel } = gameContext.currentMove

  // Calculate timing metrics
  const totalTime = Date.now() - startTime // Total time (includes alignment)
  const pureMoveTime = Date.now() - moveStartTime // Pure movement time (after alignment)
  const alignmentTime = totalTime - pureMoveTime // Time spent in alignment

  const myBomber = getBomber(gameContext.currentState, gameContext.myUid)
  if (myBomber && startPixel) {
    // Calculate PIXEL distance moved (use startPixel instead of startGrid for accuracy)
    const pixelsMoved = Math.abs(myBomber.x - startPixel.x) + Math.abs(myBomber.y - startPixel.y)

    // Calculate GRID distance moved (1 grid = 40px)
    const gridsMoved = Math.round(pixelsMoved / GRID_SIZE)

    if (gridsMoved > 0) {
      const msPerGridActual = pureMoveTime / gridsMoved // Use pure move time (no alignment)
      const msPerGridTheoretical = (GRID_SIZE / myBomber.speed) * STEP_DELAY // (40/speed) * 17ms
      const difference = msPerGridActual - msPerGridTheoretical
      const percentDiff = ((difference / msPerGridTheoretical) * 100).toFixed(0)

      console.log(`📊 TIMING: Moved ${pixelsMoved}px (${gridsMoved} grids)`)
      console.log(`   Total: ${totalTime}ms (move: ${pureMoveTime}ms, align: ${alignmentTime}ms)`)
      console.log(
        `   Speed: ${msPerGridActual.toFixed(0)}ms/grid | Theory: ${msPerGridTheoretical.toFixed(0)}ms/grid @ speed ${myBomber.speed}`,
      )
      console.log(
        `   Difference: ${difference > 0 ? "+" : ""}${difference.toFixed(0)}ms (${percentDiff > 0 ? "+" : ""}${percentDiff}%)`,
      )

      // Track stats for adjustment if needed
      if (Math.abs(percentDiff) > 50) {
        console.log(`   ⚠️ Large timing deviation detected - may need adjustment`)
      }
    }
  }
  console.log(`✅ Move complete: ${direction}`)
  gameContext.currentMove = null

  // Priority 1: Continue escape mode
  if (pathModeManager.isEscaping() && pathModeManager.getRemainingEscapeSteps() > 0) {
    const nextMove = pathModeManager.getNextEscapeMove()

    // CRITICAL SAFETY CHECK: Re-validate escape destination
    const myBomber = getBomber(gameContext.currentState, gameContext.myUid)
    if (!myBomber) {
      console.log(`⚠️ Cannot validate escape - no bomber data`)
      pathModeManager.completeEscape()
      makeDecision()
      return
    }

    const currentPos = toGridCoords(myBomber.x, myBomber.y)
    let nextX = currentPos.x
    let nextY = currentPos.y

    for (const [dx, dy, dir] of DIRS) {
      if (dir === direction) {
        nextX += dx
        nextY += dy
        break
      }
    }

    // CRITICAL TIMING CHECK: Abort if next position timing unsafe
    const { bombs = [], bombers = [] } = gameContext.currentState
    const { isSafe, blockingBomb } = checkNextPositionTimingSafe({
      nextX,
      nextY,
      bombs,
      bombers,
      myBomber,
      mode: "escape",
    })

    if (!isSafe && blockingBomb) {
      console.log(`⚠️ ESCAPE ABORT: Next position [${nextX},${nextY}] timing UNSAFE!`)
      console.log(
        `   💣 Bomb at [${blockingBomb.pos.x},${blockingBomb.pos.y}] explodes in ${blockingBomb.timeLeft.toFixed(0)}ms`,
      )
      pathModeManager.completeEscape()
      makeDecision()
      return
    }

    console.log(
      `🏃 Continuing escape: ${nextMove} (${pathModeManager.getRemainingEscapeSteps()} steps remaining)`,
    )
    setTimeout(() => {
      smoothMove(nextMove, true)
    }, STEP_DELAY)
  }
  // Priority 2: Continue follow mode
  else if (pathModeManager.isFollowing() && pathModeManager.getRemainingFollowSteps() > 0) {
    const nextMove = pathModeManager.getNextFollowMove()

    // CRITICAL SAFETY CHECK
    const myBomber = getBomber(gameContext.currentState, gameContext.myUid)
    if (!myBomber) {
      console.log(`⚠️ Cannot validate safety - no bomber data`)
      pathModeManager.completeFollow()
      makeDecision()
      return
    }

    const currentPos = toGridCoords(myBomber.x, myBomber.y)
    let nextX = currentPos.x
    let nextY = currentPos.y

    for (const [dx, dy, dir] of DIRS) {
      if (dir === direction) {
        nextY += dy
        nextX += dx
        break
      }
    }

    const { bombs = [], bombers = [] } = gameContext.currentState
    const { isSafe, blockingBomb } = checkNextPositionTimingSafe({
      nextX,
      nextY,
      bombs,
      bombers,
      myBomber,
      mode: "follow",
    })

    if (!isSafe && blockingBomb) {
      console.log(`⚠️ FOLLOW ABORT: Next position [${nextX},${nextY}] timing UNSAFE!`)
      pathModeManager.completeFollow()
      makeDecision()
      return
    }

    console.log(
      `🚶 Continuing follow: ${nextMove} (${pathModeManager.getRemainingFollowSteps()} steps remaining)`,
    )
    setTimeout(() => {
      smoothMove(nextMove, false)
    }, STEP_DELAY)
  } else {
    // Path complete
    if (pathModeManager.isEscaping()) {
      pathModeManager.completeEscape()
      const myBomber = getBomber(gameContext.currentState, gameContext.myUid)
      if (myBomber) {
        setTimeout(() => {
          makeDecision()
        }, GRID_SIZE / myBomber.speed)
        return
      }
    }

    if (pathModeManager.isFollowing()) {
      pathModeManager.completeFollow()
    }

    setTimeout(() => {
      makeDecision()
    }, STEP_DELAY)
  }
}

/**
 * Main decision making function
 */
function makeDecision() {
  // Skip AI decisions in manual mode
  if (manualControlManager.isManualMode()) {
    return
  }

  console.log(`${"=".repeat(90)}`)
  console.log(`Start decision making...`)
  if (!gameContext.currentState || !gameContext.myUid) return

  // CRITICAL: If in follow mode, skip decision making (following planned path)
  if (pathModeManager.isFollowing() && pathModeManager.getRemainingFollowSteps() > 0) {
    console.log(
      `🚶 FOLLOW MODE ACTIVE - Skipping decision (${pathModeManager.getRemainingFollowSteps()} steps remaining)`,
    )
    return
  }

  // CRITICAL: If in escape mode, check if path is still valid
  if (pathModeManager.isEscaping()) {
    if (pathModeManager.getRemainingEscapeSteps() === 0) {
      console.log(`⚠️  ESCAPE MODE but path is empty! Re-evaluating...`)
      pathModeManager.abortEscape("Path empty")
      // Fall through to make new decision
    } else {
      console.log(
        `🏃 ESCAPE MODE ACTIVE - Skipping decision (${pathModeManager.getRemainingEscapeSteps()} steps remaining)`,
      )
      return
    }
  }

  // Don't make new decisions if a move is already in progress
  if (gameContext.moveIntervalId || gameContext.alignIntervalId) {
    console.log("⏸️  Move in progress, skipping decision")
    return
  }

  const myBomber = getBomber(gameContext.currentState, gameContext.myUid)
  if (!myBomber) return

  console.log(
    `\n📍 Position: [${Math.floor(myBomber.x / GRID_SIZE)}, ${Math.floor(
      myBomber.y / GRID_SIZE,
    )}] | Pixel: [${myBomber.x}, ${myBomber.y}]`,
  )

  try {
    const decision = decideNextAction(gameContext.currentState, gameContext.myUid)
    const { action, escapeAction, isEscape, fullPath, fullPathCoordinates } = decision

    console.log("=> Decide Next Action:", action, escapeAction, isEscape, fullPath)

    // Handle bomb placement FIRST before escape mode (don't let escape block bombing)
    if (action === "BOMB") {
      placeBomb()

      // Execute escape immediately after placing bomb
      executeEscapeAfterBomb(pathModeManager, escapeAction, isEscape, fullPath, fullPathCoordinates)
      return
    }

    // If this is an escape decision with a full path, enter escape mode
    if (isEscape && fullPath && fullPath.length > 0) {
      pathModeManager.startEscape(fullPath, fullPathCoordinates)
      const firstMove = pathModeManager.getNextEscapeMove()
      smoothMove(firstMove, true)
      return
    }

    if (["UP", "DOWN", "LEFT", "RIGHT"].includes(action)) {
      // Check if this is a multi-step path (exploration/targeting)
      if (!isEscape && fullPath && fullPath.length > 1) {
        pathModeManager.startFollow(fullPath, fullPathCoordinates)
        const firstMove = pathModeManager.getNextFollowMove()
        smoothMove(firstMove, false)
      } else {
        // Single move or no full path - just move once
        smoothMove(action)
      }
    } else if (action === "STAY") {
      console.log(`⏸️  Staying put`)
      setTimeout(() => {
        makeDecision()
      }, 1000)
    }
  } catch (err) {
    console.error("⚠️ Decision error:", err)
  }
}

// ==================== MANUAL CONTROL HANDLERS ====================

function handleManualMove(direction, useSmoothMove) {
  // Cancel any ongoing AI movements
  gameContext.forceClearIntervals()

  if (useSmoothMove) {
    // Use smooth movement (full grid cell)
    console.log(`   📏 Using smooth move (full cell)`)
    smoothMove(direction, false)
  } else {
    // Send direct single-step move command
    console.log(`   👣 Sending single step: ${direction}`)
    sendMoveCommand(direction, socket)
  }
}

function handleManualBomb() {
  placeBomb()
}

function handleModeToggle() {
  // Switched to AI mode, make a decision
  makeDecision()
}

function getCurrentState() {
  return {
    currentState: gameContext.currentState,
    myUid: gameContext.myUid,
  }
}

// ==================== SOCKET SETUP ====================

registerSocketHandlers(
  socket,
  gameContext,
  pathModeManager,
  bombTracker,
  manualControlManager,
  makeDecision,
  () =>
    setupManualControl(
      manualControlManager,
      handleManualMove,
      handleManualBomb,
      handleModeToggle,
      getCurrentState,
    ),
)
