import "dotenv/config"
import socketManager from "./socket/SocketManager.js"
import { decideNextAction } from "./bot/agent.js"
import { STEP_DELAY, GRID_SIZE, DIRS } from "./utils/constants.js"
import { inBounds, toGridCoords } from "./utils/gridUtils.js"

// Import helpers
import {
  sendMoveCommand,
  alignToGrid,
  calculateStuckTimeout,
  isStuck,
  calculateMovementTiming,
} from "./helpers/movement.js"
import { BombTracker, isWalkable, getBomber } from "./helpers/gameState.js"
import { PathModeManager } from "./helpers/pathMode.js"
import { ManualControlManager, setupManualControl } from "./helpers/manualControl.js"
import { registerSocketHandlers } from "./handlers/socketHandlers.js"
import { checkNextPositionTimingSafe } from "./helpers/safetyCheck.js"
import { moveQueue } from "./helpers/moveQueue.js"

// ==================== INITIALIZATION ====================
export const offset = (GRID_SIZE - 35) / 2
const socket = socketManager.getSocket()

// Game context - shared state across all modules
const gameContext = {
  currentState: null,
  myUid: null,
  moveIntervalId: null,
  alignIntervalId: null,
  currentMove: null, // Track current movement context
  waitingForBombPlacement: false, // Track if waiting for bomb confirmation
  forceClearIntervals: () => {
    if (gameContext.moveIntervalId) {
      clearInterval(gameContext.moveIntervalId)
      gameContext.moveIntervalId = null
    }
    if (gameContext.alignIntervalId) {
      clearInterval(gameContext.alignIntervalId)
      gameContext.alignIntervalId = null
    }
    // Abort pending moves in queue (don't clear completed moves)
    moveQueue.abort("Movement interrupted")
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

  await alignToGrid(
    direction,
    { targetX: targetPixelX, targetY: targetPixelY },
    myBomber,
    socket,
    gameContext,
  )

  // CRITICAL: Get fresh bomber data after alignment!
  const myBomberAfterAlign = getBomber(gameContext.currentState, gameContext.myUid)
  if (!myBomberAfterAlign) {
    console.log("⚠️  Bomber not found after alignment")
    return
  }

  console.log(
    "   🎯 Aligned to grid, proceeding with move..., bot pixel position:",
    myBomberAfterAlign.x,
    myBomberAfterAlign.y,
  )

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
    startTime: movementStartTime,
    startGrid: movementStartGrid,
    isEscaping: pathModeManager.isEscaping(),
    isFollowing: pathModeManager.isFollowing(),
  }

  // STUCK DETECTION: Track position to detect if bot is stuck
  let lastPosition = { x: myBomber.x, y: myBomber.y }
  let stuckCounter = 0
  const { MAX_STUCK_TIME, MAX_STUCK_CHECKS } = calculateStuckTimeout(myBomber.speed)
  const MOVEMENT_THRESHOLD = 2 // Must move at least 2px to count as progress

  console.log(
    `🎯 Moving ${direction} to [${nextGridX}, ${nextGridY}] | Speed: ${myBomber.speed} | Timeout: ${MAX_STUCK_TIME}ms`,
  )

  // CRITICAL: Server requires continuous move commands to animate movement
  // Queue will handle rate limiting (15ms) and deduplication
  gameContext.moveIntervalId = setInterval(() => {
    const currentBomber = getBomber(gameContext.currentState, gameContext.myUid)
    if (!currentBomber) return

    const currentPixelX = currentBomber.x
    const currentPixelY = currentBomber.y

    // Check if bot is stuck (not moving)
    if (isStuck({ x: currentPixelX, y: currentPixelY }, lastPosition, MOVEMENT_THRESHOLD)) {
      stuckCounter++
      if (stuckCounter >= MAX_STUCK_CHECKS) {
        console.log(`⚠️  BOT STUCK! No movement detected for ${MAX_STUCK_TIME}ms`)
        console.log(`   Target: [${nextGridX}, ${nextGridY}] (${targetPixelX}, ${targetPixelY})px`)
        console.log(
          `   Current: [${Math.floor(currentPixelX / GRID_SIZE)}, ${Math.floor(currentPixelY / GRID_SIZE)}] (${currentPixelX}, ${currentPixelY})px`,
        )

        // Abort current path and re-evaluate
        if (pathModeManager.isEscaping()) {
          pathModeManager.abortEscape("Path blocked")
        }
        if (pathModeManager.isFollowing()) {
          pathModeManager.abortFollow("Path blocked")
        }

        gameContext.forceClearIntervals()
        gameContext.currentMove = null
        makeDecision()
        stuckCounter = 0
        return
      }
    } else {
      // Bot is moving, reset stuck counter
      stuckCounter = 0
      lastPosition = { x: currentPixelX, y: currentPixelY }
    }

    // Check if reached target
    const distanceToTarget =
      direction === "UP" || direction === "DOWN"
        ? Math.abs(currentPixelY - targetPixelY)
        : Math.abs(currentPixelX - targetPixelX)

    if (distanceToTarget <= offset) {
      clearInterval(gameContext.moveIntervalId)
      gameContext.moveIntervalId = null
      handleMoveComplete()
    } else {
      // CRITICAL: Send move command continuously (queue will deduplicate)
      sendMoveCommand(socket, direction, "normal")
    }
  }, STEP_DELAY)
}

/**
 * Handle move completion - called when bot reaches target position
 * This is triggered by position tracking in smoothMove
 */
function handleMoveComplete() {
  if (!gameContext.currentMove) return

  const { direction, startTime, startGrid } = gameContext.currentMove

  // Calculate actual movement time
  const actualMoveTime = Date.now() - startTime
  const myBomber = getBomber(gameContext.currentState, gameContext.myUid)
  if (myBomber && startGrid) {
    const gridMoved = Math.abs(myBomber.x - startGrid.x) + Math.abs(myBomber.y - startGrid.y)
    const timing = calculateMovementTiming(actualMoveTime, gridMoved, myBomber.speed)
    if (timing) {
      console.log(
        `📊 TIMING: Moved ${gridMoved}px in ${actualMoveTime}ms (${timing.timePerGrid.toFixed(1)}ms/grid)`,
      )
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

    if (nextMove === "UP") nextY--
    else if (nextMove === "DOWN") nextY++
    else if (nextMove === "LEFT") nextX--
    else if (nextMove === "RIGHT") nextX++

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

    if (nextMove === "UP") nextY--
    else if (nextMove === "DOWN") nextY++
    else if (nextMove === "LEFT") nextX--
    else if (nextMove === "RIGHT") nextX++

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

      // CRITICAL: Set flag to prevent re-evaluation during bomb placement wait
      gameContext.waitingForBombPlacement = true

      // CRITICAL: Wait for server to confirm bomb placement before escaping
      // Otherwise bot might move before bomb is placed, causing deadlock
      let escapeExecuted = false

      const bombPlacementTimeout = setTimeout(() => {
        if (!escapeExecuted) {
          console.log("⚠️  Bomb placement timeout - proceeding with escape anyway")
          escapeExecuted = true
          gameContext.waitingForBombPlacement = false
          executeEscapeAfterBomb(
            pathModeManager,
            escapeAction,
            isEscape,
            fullPath,
            fullPathCoordinates,
          )
        }
      }, 500) // Max 500ms wait for server confirmation

      // Set up one-time listener for bomb confirmation
      const bombConfirmHandler = (bomb) => {
        // Only proceed if this is OUR bomb and we haven't escaped yet
        if (bomb.uid === gameContext.myUid && !escapeExecuted) {
          clearTimeout(bombPlacementTimeout)
          console.log("✅ Bomb confirmed at current position - proceeding with escape")
          escapeExecuted = true
          gameContext.waitingForBombPlacement = false
          executeEscapeAfterBomb(
            pathModeManager,
            escapeAction,
            isEscape,
            fullPath,
            fullPathCoordinates,
          )
        }
      }

      // Use once() to auto-remove listener after first trigger
      socket.once("new_bomb", bombConfirmHandler)

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
    sendMoveCommand(socket, direction)
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
