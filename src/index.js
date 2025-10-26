import "dotenv/config"
import socketManager from "./socket/SocketManager.js"
import { decideNextAction, findUnsafeTiles } from "./bot/agent.js"
import { STEP_DELAY, GRID_SIZE, MAP_WIDTH, MAP_HEIGHT } from "./utils/constants.js"
import { toGridCoords } from "./utils/gridUtils.js"

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

// ==================== INITIALIZATION ====================

const socket = socketManager.getSocket()
const offset = (GRID_SIZE - 35) / 2

// Game context - shared state across all modules
const gameContext = {
  currentState: null,
  myUid: null,
  moveIntervalId: null,
  alignIntervalId: null,
  forceClearIntervals: () => {
    if (gameContext.moveIntervalId) {
      clearInterval(gameContext.moveIntervalId)
      gameContext.moveIntervalId = null
    }
    if (gameContext.alignIntervalId) {
      clearInterval(gameContext.alignIntervalId)
      gameContext.alignIntervalId = null
    }
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
function executeEscapeAfterBomb(pathModeManager, escapeAction, isEscape, fullPath) {
  // After placing a bomb, start the full escape sequence if available
  if (isEscape && fullPath && fullPath.length > 0) {
    pathModeManager.startEscape(fullPath)
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
 */
async function smoothMove(direction, isEscapeMove = false) {
  // Track movement timing
  const movementStartTime = Date.now()

  // Clear any existing intervals before starting a new move
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

  await alignToGrid(direction, myBomber, socket, gameContext)

  const { x: currentX, y: currentY } = toGridCoords(myBomber.x, myBomber.y)
  let nextGridX = currentX
  let nextGridY = currentY

  switch (direction) {
    case "UP":
      nextGridY--
      break
    case "DOWN":
      nextGridY++
      break
    case "LEFT":
      nextGridX--
      break
    case "RIGHT":
      nextGridX++
      break
  }

  const targetPixelX = nextGridX * GRID_SIZE + offset
  const targetPixelY = nextGridY * GRID_SIZE + offset

  // CRITICAL: Validate target tile is walkable before attempting to move
  if (
    nextGridX < 0 ||
    nextGridX >= MAP_WIDTH ||
    nextGridY < 0 ||
    nextGridY >= MAP_HEIGHT ||
    !isWalkable(
      gameContext.currentState.map,
      nextGridX,
      nextGridY,
      gameContext.currentState.bombs,
      gameContext.myUid,
    )
  ) {
    console.log(
      `❌ BLOCKED: Cannot move ${direction} to [${nextGridX}, ${nextGridY}] - tile not walkable!`,
    )

    // Abort current path since next step is blocked
    if (pathModeManager.isEscaping()) {
      pathModeManager.abortEscape("Next tile blocked")
    }
    if (pathModeManager.isFollowing()) {
      pathModeManager.abortFollow("Next tile blocked")
    }

    // Re-evaluate immediately
    setTimeout(() => {
      makeDecision()
    }, STEP_DELAY)
    return
  }

  // STUCK DETECTION: Track position to detect if bot is stuck
  let lastPosition = { x: myBomber.x, y: myBomber.y }
  let stuckCounter = 0
  const { MAX_STUCK_TIME, MAX_STUCK_CHECKS } = calculateStuckTimeout(myBomber.speed)
  const MOVEMENT_THRESHOLD = 2 // Must move at least 2px to count as progress

  console.log(
    `🎯 Moving ${direction} to [${nextGridX}, ${nextGridY}] | Speed: ${myBomber.speed} | Timeout: ${MAX_STUCK_TIME}ms`,
  )

  gameContext.moveIntervalId = setInterval(() => {
    const currentPixelX = myBomber.x
    const currentPixelY = myBomber.y

    // Check if bot is stuck (not moving)
    if (isStuck({ x: currentPixelX, y: currentPixelY }, lastPosition, MOVEMENT_THRESHOLD)) {
      stuckCounter++
      if (stuckCounter >= MAX_STUCK_CHECKS) {
        console.log(`⚠️  BOT STUCK! No movement detected for ${MAX_STUCK_TIME}ms`)
        console.log(`   Target: [${nextGridX}, ${nextGridY}] (${targetPixelX}, ${targetPixelY})px`)
        console.log(
          `   Current: [${Math.floor(currentPixelX / GRID_SIZE)}, ${Math.floor(currentPixelY / GRID_SIZE)}] (${currentPixelX}, ${currentPixelY})px`,
        )
        console.log(
          `   ❌ ALIGNMENT ISSUE: Bot not on grid (X%40=${currentPixelX % GRID_SIZE}, Y%40=${currentPixelY % GRID_SIZE})`,
        )
        clearInterval(gameContext.moveIntervalId)
        gameContext.moveIntervalId = null

        // Abort current path and re-evaluate
        if (pathModeManager.isEscaping()) {
          pathModeManager.abortEscape("Path blocked")
        }
        if (pathModeManager.isFollowing()) {
          pathModeManager.abortFollow("Path blocked")
        }

        // Re-evaluate immediately
        setTimeout(() => {
          makeDecision()
        }, STEP_DELAY)
        return
      }
    } else {
      // Bot is moving, reset stuck counter
      stuckCounter = 0
      lastPosition = { x: currentPixelX, y: currentPixelY }
    }

    const distanceToTarget =
      direction === "UP" || direction === "DOWN"
        ? Math.abs(currentPixelY - targetPixelY)
        : Math.abs(currentPixelX - targetPixelX)

    if (distanceToTarget <= offset) {
      clearInterval(gameContext.moveIntervalId)
      gameContext.moveIntervalId = null

      // Calculate actual movement time
      const actualMoveTime = Date.now() - movementStartTime
      const myBomber = getBomber(gameContext.currentState, gameContext.myUid)
      if (myBomber && movementStartGrid) {
        const gridMoved =
          Math.abs(myBomber.x - movementStartGrid.x) + Math.abs(myBomber.y - movementStartGrid.y)
        const timing = calculateMovementTiming(actualMoveTime, gridMoved, myBomber.speed)
        if (timing) {
          console.log(
            `📊 TIMING MEASUREMENT: Moved ${gridMoved} grid(s) in ${actualMoveTime}ms (${timing.timePerGrid.toFixed(1)}ms/grid). Theoretical: ${timing.theoreticalTime.toFixed(1)}ms/grid. Diff: ${timing.difference.toFixed(1)}ms`,
          )
        }
      }

      console.log(`✅ Move complete: ${direction}`)

      // Priority 1: Continue escape mode
      if (pathModeManager.isEscaping() && pathModeManager.getRemainingEscapeSteps() > 0) {
        const nextMove = pathModeManager.getNextEscapeMove()
        console.log(
          `🏃 Continuing escape: ${nextMove} (${pathModeManager.getRemainingEscapeSteps()} steps remaining)`,
        )
        // Small delay between escape moves to ensure position updates
        setTimeout(() => {
          smoothMove(nextMove, true)
        }, STEP_DELAY)
      }
      // Priority 2: Continue follow mode (exploration/targeting paths)
      else if (pathModeManager.isFollowing() && pathModeManager.getRemainingFollowSteps() > 0) {
        const nextMove = pathModeManager.getNextFollowMove()
        console.log(
          `🚶 Continuing follow path: ${nextMove} (${pathModeManager.getRemainingFollowSteps()} steps remaining)`,
        )
        setTimeout(() => {
          smoothMove(nextMove, false)
        }, STEP_DELAY)
      } else {
        // Path complete - check which mode we were in
        if (pathModeManager.isEscaping()) {
          pathModeManager.completeEscape()
          console.log(`   ⏸️  Waiting before next decision to ensure safety...`)
          // Wait for bombs to explode before re-evaluating
          setTimeout(() => {
            console.log(`   🔍 Re-evaluating safety after escape...`)
            makeDecision()
          }, GRID_SIZE / myBomber.speed)
          return // Don't call makeDecision immediately
        }

        if (pathModeManager.isFollowing()) {
          pathModeManager.completeFollow()
        }

        // Normal move completed, make new decision
        setTimeout(() => {
          makeDecision()
        }, STEP_DELAY) // Small delay to let position update
      }
    } else {
      sendMoveCommand(socket, direction)
    }
  }, STEP_DELAY)
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
    )}] | Pixel: [${myBomber.x}, ${myBomber.y}] | Orient: ${myBomber.orient}`,
  )

  try {
    const decision = decideNextAction(gameContext.currentState, gameContext.myUid)
    const { action, escapeAction, isEscape, fullPath } = decision

    console.log("=> Decide Next Action:", action, escapeAction, isEscape, fullPath)

    // Handle bomb placement FIRST before escape mode (don't let escape block bombing)
    if (action === "BOMB") {
      placeBomb()

      // CRITICAL: Wait for server to confirm bomb placement before escaping
      // Otherwise bot might move before bomb is placed, causing deadlock
      let escapeExecuted = false

      const bombPlacementTimeout = setTimeout(() => {
        if (!escapeExecuted) {
          console.log("⚠️  Bomb placement timeout - proceeding with escape anyway")
          escapeExecuted = true
          executeEscapeAfterBomb(pathModeManager, escapeAction, isEscape, fullPath)
        }
      }, 500) // Max 500ms wait for server confirmation

      // Set up one-time listener for bomb confirmation
      const bombConfirmHandler = (bomb) => {
        // Only proceed if this is OUR bomb and we haven't escaped yet
        if (bomb.uid === gameContext.myUid && !escapeExecuted) {
          clearTimeout(bombPlacementTimeout)
          console.log("✅ Bomb confirmed at current position - proceeding with escape")
          escapeExecuted = true
          executeEscapeAfterBomb(pathModeManager, escapeAction, isEscape, fullPath)
        }
      }

      // Use once() to auto-remove listener after first trigger
      socket.once("new_bomb", bombConfirmHandler)

      return
    }

    // If this is an escape decision with a full path, enter escape mode
    if (isEscape && fullPath && fullPath.length > 0) {
      pathModeManager.startEscape(fullPath)
      const firstMove = pathModeManager.getNextEscapeMove()
      smoothMove(firstMove, true)
      return
    }

    if (["UP", "DOWN", "LEFT", "RIGHT"].includes(action)) {
      // Check if this is a multi-step path (exploration/targeting)
      if (!isEscape && fullPath && fullPath.length > 1) {
        pathModeManager.startFollow(fullPath)
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
