import "dotenv/config"
import socketManager from "./socket/SocketManager.js"
import { decideNextAction } from "./bot/agent.js"
import { STEP_DELAY, GRID_SIZE, BOT_SIZE, ITEMS, WALKABLE } from "./utils/constants.js"
import readline from "readline"

// Import utility functions for escape path validation
import { findUnsafeTiles } from "./bot/agent.js"
import { toGridCoords } from "./utils/gridUtils.js"

const socket = socketManager.getSocket()
const offset = (GRID_SIZE - BOT_SIZE) / 2

let currentState = null
let myUid = null
let moveIntervalId = null
let alignIntervalId = null
let escapeMode = false
let escapePath = []
let followMode = false // For following exploration/target paths
let followPath = []
let manualMode = false
let useSmootMovesInManual = true

// Track bomb positions for walkable detection
// Map of "bombId" -> { gridX, gridY, bomberUid }
const bombTracking = new Map()

// ==================== MANUAL CONTROL SETUP ====================

function setupManualControl() {
  console.log("\n" + "=".repeat(80))
  console.log("🎮 MANUAL CONTROL ENABLED")
  console.log("=".repeat(80))
  console.log("Controls:")
  console.log("  W / w / ↑ - Move UP")
  console.log("  S / s / ↓ - Move DOWN")
  console.log("  A / a / ← - Move LEFT")
  console.log("  D / d / → - Move RIGHT")
  console.log("  SPACE / B / b - Place BOMB")
  console.log("  M / m - Toggle Manual/AI mode")
  console.log("  T / t - Toggle smooth/step movement (manual mode)")
  console.log("  Q / q - Quit")
  console.log("=".repeat(80))
  console.log(`Current Mode: ${manualMode ? "🎮 MANUAL" : "🤖 AI"}`)
  console.log(
    `Movement Type: ${useSmootMovesInManual ? "📏 Smooth (full cell)" : "👣 Step-by-step"}`,
  )
  console.log("=".repeat(80) + "\n")
  console.log("⌨️  Keyboard listener active - press any key to test...")

  // Setup readline for keyboard input
  readline.emitKeypressEvents(process.stdin)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    console.log("✅ Terminal is in raw mode (keyboard ready)")
  } else {
    console.log("⚠️  Warning: Terminal is not TTY - keyboard input may not work")
  }

  process.stdin.on("keypress", (str, key) => {
    // Handle Ctrl+C to exit
    if (key && key.ctrl && key.name === "c") {
      process.exit()
    }

    // Handle quit
    if (key && key.name === "q") {
      console.log("\n👋 Quitting...")
      process.exit()
    }

    // Need game state for movement commands
    if (!currentState || !myUid) {
      console.log("⚠️  Waiting for game state...")
      return
    }

    // Ignore keys with ctrl modifier (except Ctrl+C which we handle above)
    if (key && key.ctrl) {
      return
    }

    // Toggle manual/AI mode
    if (key && key.name === "m") {
      manualMode = !manualMode
      console.log(`\n🔄 Mode switched to: ${manualMode ? "🎮 MANUAL CONTROL" : "🤖 AI CONTROL"}\n`)
      if (!manualMode) {
        // Switched to AI mode, make a decision
        makeDecision()
      }
      return
    }

    // Toggle smooth/step movement in manual mode
    if (key && key.name === "t") {
      useSmootMovesInManual = !useSmootMovesInManual
      console.log(
        `\n🔄 Movement type: ${useSmootMovesInManual ? "📏 Smooth (full cell)" : "👣 Step-by-step"}\n`,
      )
      return
    }

    // Only process movement keys in manual mode
    if (!manualMode) return

    const myBomber = currentState.bombers.find((b) => b.uid === myUid)
    if (!myBomber) {
      console.log("⚠️  Bomber not found in game state")
      return
    }

    let action = null

    // Map keys to actions - check both key object and string
    const keyName = key?.name || str?.toLowerCase()

    switch (keyName) {
      case "w":
      case "up":
        action = "UP"
        break
      case "s":
      case "down":
        action = "DOWN"
        break
      case "a":
      case "left":
        action = "LEFT"
        break
      case "d":
      case "right":
        action = "RIGHT"
        break
      case "space":
      case "b":
        console.log("💣 Placing bomb (manual)")
        placeBomb()
        return
    }

    if (action) {
      console.log(`\n🎮 Manual control: ${action}`)
      console.log(
        `   Current: [${Math.floor(myBomber.x / GRID_SIZE)}, ${Math.floor(myBomber.y / GRID_SIZE)}] | Pixel: [${myBomber.x}, ${myBomber.y}]`,
      )

      // Cancel any ongoing AI movements
      if (moveIntervalId) {
        clearInterval(moveIntervalId)
        moveIntervalId = null
      }
      if (alignIntervalId) {
        clearInterval(alignIntervalId)
        alignIntervalId = null
      }

      if (useSmootMovesInManual) {
        // Use smooth movement (full grid cell)
        console.log(`   📏 Using smooth move (full cell)`)
        smoothMove(action, false)
      } else {
        // Send direct single-step move command
        console.log(`   👣 Sending single step: ${action}`)
        move(action)
      }
    }
  })
}

function forceClearIntervals() {
  if (moveIntervalId) {
    clearInterval(moveIntervalId)
    moveIntervalId = null
  }
  if (alignIntervalId) {
    clearInterval(alignIntervalId)
    alignIntervalId = null
  }
}

// ==================== SOCKET EVENTS ====================

socket.on("connect", () => {
  console.log("✅ Connected:", socket.id)
  socket.emit("join", {})
  myUid = socket.id
  setupManualControl()
})

socket.on("user", (state) => {
  currentState = state
  // Only make decision if not in manual mode AND not currently escaping
  if (!manualMode && !escapeMode && !moveIntervalId && !alignIntervalId) {
    makeDecision()
  }
})

socket.on("player_move", (data) => {
  if (!currentState || !data.uid) return
  const { x: bomberX, y: bomberY } = toGridCoords(data.x, data.y)

  if (data.uid === myUid) {
    bombTracking.forEach((bombInfo, bombId) => {
      const hasMovedAway = bomberX !== bombInfo.gridX || bomberY !== bombInfo.gridY
      if (hasMovedAway) {
        bombTracking.delete(bombId)

        // Find the bomb in currentState and update its flag
        const bomb = currentState.bombs.find((b) => b.id === bombId)
        if (bomb && bomb.walkable) bomb.walkable = false
      }
    })
  }

  // Update bomber's position in state
  const bomber = currentState.bombers.find((b) => b.uid === data.uid)
  if (bomber) {
    bomber.x = data.x
    bomber.y = data.y
  }
})

socket.on("new_bomb", (bomb) => {
  if (!currentState) return

  // DEBUG: Log bomb object details to understand server data
  const now = Date.now()
  console.log(`\n💣 NEW BOMB DEBUG:`)
  console.log(`   ID: ${bomb.id}`)
  console.log(`   Position: [${Math.floor(bomb.x / GRID_SIZE)}, ${Math.floor(bomb.y / GRID_SIZE)}]`)
  console.log(`   Owner UID: ${bomb.uid}`)
  console.log(`   Created At (server): ${bomb.createdAt}`)
  console.log(`   Life Time (server): ${bomb.lifeTime}`)
  console.log(`   Client Time (now): ${now}`)
  console.log(`   Time Diff: ${now - bomb.createdAt}ms`)
  console.log(`   Will explode in: ${bomb.lifeTime - (now - bomb.createdAt)}ms`)
  console.log(`   Full bomb object:`, JSON.stringify(bomb, null, 2))

  const myBomber = currentState.bombers.find((b) => b.uid === myUid)
  const { x: bombX, y: bombY } = toGridCoords(bomb.x, bomb.y)

  // Check if Bot is standing on the bomb tile when it's placed
  // ONLY set walkable if this is OUR bomb (we just placed it)
  let botOnTheBomb = false
  if (myBomber) {
    const { x: myBomberX, y: myBomberY } = toGridCoords(myBomber.x, myBomber.y)
    botOnTheBomb = myBomberX === bombX && myBomberY === bombY
  }
  bomb.walkable = botOnTheBomb

  if (!bombTracking.has(bomb.id) && botOnTheBomb) {
    bombTracking.set(bomb.id, {
      gridX: bombX,
      gridY: bombY,
      bomberUid: bomb.uid,
    })
  }
  currentState.bombs.push(bomb)

  // CRITICAL: Check if new bomb affects our paths

  // Check escape path first (highest priority)
  if (escapeMode && escapePath.length > 0) {
    console.log(`\n🚨 NEW BOMB during escape! Checking if escape path is still safe...`)

    const myBomber = currentState.bombers.find((b) => b.uid === myUid)
    if (myBomber) {
      const playerGridPos = toGridCoords(myBomber.x, myBomber.y)

      // Check if the new bomb threatens our escape path
      const unsafeTiles = findUnsafeTiles(
        currentState.map,
        currentState.bombs,
        currentState.bombers,
      )

      // Calculate DESTINATION from CURRENT position (not start position)
      let finalX = playerGridPos.x
      let finalY = playerGridPos.y

      for (const step of escapePath) {
        if (step === "UP") finalY--
        else if (step === "DOWN") finalY++
        else if (step === "LEFT") finalX--
        else if (step === "RIGHT") finalX++
      }

      const destinationUnsafe = unsafeTiles.has(`${finalX},${finalY}`)
      const currentUnsafe = unsafeTiles.has(`${playerGridPos.x},${playerGridPos.y}`)

      console.log(
        `   Current: [${playerGridPos.x}, ${playerGridPos.y}] ${currentUnsafe ? "❌ UNSAFE" : "✅ safe"}`,
      )
      console.log(
        `   Destination: [${finalX}, ${finalY}] ${destinationUnsafe ? "❌ UNSAFE" : "✅ safe"}`,
      )
      console.log(`   Path remaining: ${escapePath.join(" → ")}`)

      if (destinationUnsafe) {
        console.log(`   ⚠️  Escape DESTINATION is unsafe!`)
        console.log(`   🔄 ABORT ESCAPE - Finding new escape route!`)
        // Cancel current escape
        escapeMode = false
        escapePath = []
        forceClearIntervals()
        // Immediately find new escape route
        makeDecision()
      } else {
        console.log(`   ✅ Escape destination is safe, continuing escape...`)
      }
    }
  }
  // Check follow path (lower priority - abort if ANY tile becomes unsafe)
  else if (followMode && followPath.length > 0) {
    console.log(`\n🚨 NEW BOMB during follow path! Aborting and re-evaluating...`)
    followMode = false
    followPath = []
    forceClearIntervals()
    makeDecision()
  } else if (!manualMode && !escapeMode && !followMode && !moveIntervalId && !alignIntervalId) {
    // Only re-evaluate if this is NOT our own bomb (we already have an escape plan)
    const isOurBomb = bomb.uid === myUid
    if (!isOurBomb) {
      console.log("🔔 Enemy bomb detected, re-evaluating...")
      makeDecision()
    } else {
      console.log("💣 Our bomb placed, waiting for escape sequence to start...")
    }
  }
})

socket.on("bomb_explode", (bomb) => {
  if (!currentState) return
  const bombIndex = currentState.bombs.findIndex((b) => b.id === bomb.id)
  if (bombIndex !== -1) currentState.bombs.splice(bombIndex, 1)
  if (bombTracking.has(bomb.id)) bombTracking.delete(bomb.id)

  // CRITICAL: Check safety even during follow mode
  if (followMode && followPath.length > 0) {
    const myBomber = currentState.bombers.find((b) => b.uid === myUid)
    if (myBomber) {
      const playerGridPos = toGridCoords(myBomber.x, myBomber.y)
      const unsafeTiles = findUnsafeTiles(
        currentState.map,
        currentState.bombs,
        currentState.bombers,
      )

      // Check if current position is now unsafe after bomb explosion
      if (unsafeTiles.has(`${playerGridPos.x},${playerGridPos.y}`)) {
        console.log(`🚨 BOMB EXPLODED - Current position now UNSAFE! Aborting follow path!`)
        followMode = false
        followPath = []
        forceClearIntervals()
        makeDecision()
        return
      }

      console.log("💥 Bomb exploded, but still safe - continuing follow path")
    }
  } else if (escapeMode && escapePath.length > 0) {
    // CRITICAL: Even during escape, check if we're still safe
    const myBomber = currentState.bombers.find((b) => b.uid === myUid)
    if (myBomber) {
      const playerGridPos = toGridCoords(myBomber.x, myBomber.y)
      const unsafeTiles = findUnsafeTiles(
        currentState.map,
        currentState.bombs,
        currentState.bombers,
      )

      // Check if current position became unsafe after bomb explosion
      if (unsafeTiles.has(`${playerGridPos.x},${playerGridPos.y}`)) {
        console.log(`🚨 BOMB EXPLODED - Current position now UNSAFE during escape!`)
        console.log(`   Re-evaluating escape immediately...`)
        escapeMode = false
        escapePath = []
        forceClearIntervals()
        makeDecision()
        return
      }

      console.log("💥 Bomb exploded during escape, but still safe - continuing")
    }
  } else if (!manualMode && !moveIntervalId && !alignIntervalId) {
    console.log("� Bomb exploded, re-evaluating...")
    makeDecision()
  }
})

socket.on("chest_destroyed", (chest) => {
  if (!currentState) return
  const { x: chestX, y: chestY } = toGridCoords(chest.x, chest.y)
  let item = null

  if (chest.item && ITEMS.includes(chest.item?.type)) item = chest.item.type
  currentState.map[chestY][chestX] = item

  // CRITICAL: Check safety even during follow mode (chest destroyed means bomb exploded nearby)
  if (followMode && followPath.length > 0) {
    const myBomber = currentState.bombers.find((b) => b.uid === myUid)
    if (myBomber) {
      const playerGridPos = toGridCoords(myBomber.x, myBomber.y)
      const unsafeTiles = findUnsafeTiles(
        currentState.map,
        currentState.bombs,
        currentState.bombers,
      )

      // Check if current position is now unsafe after chest destruction
      if (unsafeTiles.has(`${playerGridPos.x},${playerGridPos.y}`)) {
        console.log(`🚨 CHEST DESTROYED - Current position now UNSAFE! Aborting follow path!`)
        followMode = false
        followPath = []
        forceClearIntervals()
        makeDecision()
        return
      }

      console.log("🧱 Chest destroyed, but still safe - continuing follow path")
    }
  } else if (escapeMode) {
    console.log("🏃 Escape in progress, ignoring chest destroyed event")
  } else if (!manualMode && !moveIntervalId && !alignIntervalId) {
    console.log("🧱 Chest destroyed, re-evaluating...")
    makeDecision()
  }
})

socket.on("item_collected", (data) => {
  if (!currentState) return
  const { x: itemX, y: itemY } = toGridCoords(data.item.x, data.item.y)
  currentState.map[itemY][itemX] = null

  const bomber = currentState.bombers.find((b) => b?.uid === data.bomber?.uid && b?.uid === myUid)
  if (bomber) {
    const { speed, explosionRange, bombCount } = data
    bomber.speed = speed || bomber.speed
    bomber.explosionRange = explosionRange || bomber.explosionRange
    bomber.bombCount = bombCount || bomber.bombCount
  }

  // TODO: Could also update bomber's attributes if needed
  // Only re-evaluate if we're not escaping or moving
  // if (!manualMode && !escapeMode && !moveIntervalId && !alignIntervalId) {
  //   console.log("✨ Item collected, re-evaluating...")
  //   makeDecision() // Re-evaluate decision after an item is collected
  // } else if (escapeMode) {
  //   console.log("🏃 Escape in progress, ignoring item collected event")
  // }
})

socket.on("map_update", (data) => {
  if (!currentState) return
  currentState.chests = data.chests
  currentState.items = data.items
  // if (!manualMode && !escapeMode && !moveIntervalId && !alignIntervalId) {
  //   makeDecision()
  // }
})

// ==================== ACTION HELPERS ====================

function move(direction) {
  console.log(`   📤 Sending move command: ${direction}`)
  socket.emit("move", { orient: direction })
}

function placeBomb() {
  socket.emit("place_bomb", {})
}

function alignToGrid(direction, myBomber) {
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
        if (alignIntervalId) {
          console.log(`⚠️  Alignment TIMEOUT! Clearing interval and continuing...`)
          clearInterval(alignIntervalId)
          alignIntervalId = null
          resolve()
        }
      }, maxAlignTime)

      alignIntervalId = setInterval(() => {
        if (stepsLeft > 0) {
          socket.emit("move", { orient: alignDirection })
          stepsLeft--
        } else {
          clearTimeout(alignTimeout)
          clearInterval(alignIntervalId)
          alignIntervalId = null
          return resolve()
        }
      }, STEP_DELAY - 10)
    } else {
      return resolve()
    }
  })
}

const smoothMove = async (direction, isEscapeMove = false) => {
  // Track movement timing
  const movementStartTime = Date.now()

  // Clear any existing intervals before starting a new move
  if (moveIntervalId) {
    console.log(`⚠️  Canceling previous move to start new move: ${direction}`)
    clearInterval(moveIntervalId)
    moveIntervalId = null
  }
  if (alignIntervalId) {
    console.log(`⚠️  Canceling alignment to start move: ${direction}`)
    clearInterval(alignIntervalId)
    alignIntervalId = null
  }

  const myBomber = currentState.bombers.find((b) => b.uid === myUid)
  if (!myBomber) {
    console.log("⚠️  Bomber not found in current state")
    return
  }
  const movementStartGrid = { x: myBomber?.x, y: myBomber?.y }

  await alignToGrid(direction, myBomber)

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
    !isWalkable(currentState.map, nextGridX, nextGridY, currentState.bombs, myUid)
  ) {
    console.log(
      `❌ BLOCKED: Cannot move ${direction} to [${nextGridX}, ${nextGridY}] - tile not walkable!`,
    )

    // Abort current path since next step is blocked
    if (escapeMode) {
      console.log(`   🚨 ABORTING ESCAPE - Next tile blocked!`)
      escapeMode = false
      escapePath = []
    }
    if (followMode) {
      console.log(`   🚨 ABORTING FOLLOW PATH - Next tile blocked!`)
      followMode = false
      followPath = []
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
  // Timeout based on speed: slower = need more time
  const timeToMoveOneGrid = (GRID_SIZE / myBomber.speed) * STEP_DELAY
  const MAX_STUCK_TIME = Math.max(500, timeToMoveOneGrid * 2) // At least 500ms or 2x expected time
  const MAX_STUCK_CHECKS = Math.ceil(MAX_STUCK_TIME / STEP_DELAY)
  const MOVEMENT_THRESHOLD = 2 // Must move at least 2px to count as progress

  console.log(
    `🎯 Moving ${direction} to [${nextGridX}, ${nextGridY}] | Speed: ${myBomber.speed} | Timeout: ${MAX_STUCK_TIME}ms`,
  )

  moveIntervalId = setInterval(() => {
    const currentPixelX = myBomber.x
    const currentPixelY = myBomber.y

    // Check if bot is stuck (not moving)
    const movedDistance =
      Math.abs(currentPixelX - lastPosition.x) + Math.abs(currentPixelY - lastPosition.y)

    if (movedDistance < MOVEMENT_THRESHOLD) {
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
        clearInterval(moveIntervalId)
        moveIntervalId = null

        // Abort current path and re-evaluate
        if (escapeMode) {
          console.log(`   🚨 ABORTING ESCAPE - Path blocked!`)
          escapeMode = false
          escapePath = []
        }
        if (followMode) {
          console.log(`   🚨 ABORTING FOLLOW PATH - Blocked!`)
          followMode = false
          followPath = []
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
      clearInterval(moveIntervalId)
      moveIntervalId = null

      // Calculate actual movement time
      const actualMoveTime = Date.now() - movementStartTime
      const myBomber = currentState.bombers.find((b) => b.uid === myUid)
      if (myBomber && movementStartGrid) {
        const gridMoved =
          Math.abs(myBomber.x - movementStartGrid.x) + Math.abs(myBomber.y - movementStartGrid.y)
        if (gridMoved > 0) {
          const timePerGrid = actualMoveTime / gridMoved
          const theoreticalTime = (GRID_SIZE / myBomber.speed) * STEP_DELAY
          console.log(
            `📊 TIMING MEASUREMENT: Moved ${gridMoved} grid(s) in ${actualMoveTime}ms (${timePerGrid.toFixed(1)}ms/grid). Theoretical: ${theoreticalTime.toFixed(1)}ms/grid. Diff: ${(timePerGrid - theoreticalTime).toFixed(1)}ms`,
          )
        }
      }

      console.log(`✅ Move complete: ${direction}`)

      // Priority 1: Continue escape mode
      if (escapeMode && escapePath.length > 0) {
        const nextMove = escapePath.shift()
        console.log(`🏃 Continuing escape: ${nextMove} (${escapePath.length} steps remaining)`)
        // Small delay between escape moves to ensure position updates
        setTimeout(() => {
          smoothMove(nextMove, true)
        }, STEP_DELAY)
      }
      // Priority 2: Continue follow mode (exploration/targeting paths)
      else if (followMode && followPath.length > 0) {
        const nextMove = followPath.shift()
        console.log(`🚶 Continuing follow path: ${nextMove} (${followPath.length} steps remaining)`)
        setTimeout(() => {
          smoothMove(nextMove, false)
        }, STEP_DELAY)
      } else {
        // Path complete - check which mode we were in
        if (escapeMode) {
          console.log(`✅ Escape sequence completed!`)
          escapeMode = false
          escapePath = []
          console.log(`   ⏸️  Waiting before next decision to ensure safety...`)
          // Wait for bombs to explode before re-evaluating
          setTimeout(() => {
            console.log(`   🔍 Re-evaluating safety after escape...`)
            makeDecision()
          }, GRID_SIZE / myBomber.speed)
          return // Don't call makeDecision immediately
        }

        if (followMode) {
          console.log(`✅ Follow path completed!`)
          followMode = false
          followPath = []
        }

        // Normal move completed, make new decision
        setTimeout(() => {
          makeDecision()
        }, STEP_DELAY) // Small delay to let position update
      }
    } else {
      move(direction)
    }
  }, STEP_DELAY)
}

// ==================== DECISION MAKER ====================

function makeDecision() {
  // Skip AI decisions in manual mode
  if (manualMode) {
    return
  }

  console.log(`${"=".repeat(90)}`)
  console.log(`Start decision making...`)
  if (!currentState || !myUid) return

  // CRITICAL: If in follow mode, skip decision making (following planned path)
  if (followMode && followPath.length > 0) {
    console.log(`🚶 FOLLOW MODE ACTIVE - Skipping decision (${followPath.length} steps remaining)`)
    return
  }

  // CRITICAL: If in escape mode, check if path is still valid
  if (escapeMode) {
    if (escapePath.length === 0) {
      console.log(`⚠️  ESCAPE MODE but path is empty! Re-evaluating...`)
      escapeMode = false
      // Fall through to make new decision
    } else {
      console.log(
        `🏃 ESCAPE MODE ACTIVE - Skipping decision (${escapePath.length} steps remaining)`,
      )
      return
    }
  }

  // Don't make new decisions if a move is already in progress
  if (moveIntervalId || alignIntervalId) {
    console.log("⏸️  Move in progress, skipping decision")
    return
  }

  const myBomber = currentState.bombers.find((b) => b.uid === myUid)
  if (!myBomber) return

  console.log(
    `\n📍 Position: [${Math.floor(myBomber.x / GRID_SIZE)}, ${Math.floor(
      myBomber.y / GRID_SIZE,
    )}] | Pixel: [${myBomber.x}, ${myBomber.y}] | Orient: ${myBomber.orient}`,
  )

  try {
    const decision = decideNextAction(currentState, myUid)
    const { action, escapeAction, isEscape, fullPath } = decision

    console.log("=> Decide Next Action:", action, escapeAction, isEscape, fullPath)

    // Handle bomb placement FIRST before escape mode (don't let escape block bombing)
    if (action === "BOMB") {
      // console.log(`💣 Placing bomb`)
      placeBomb()

      // After placing a bomb, start the full escape sequence if available
      if (isEscape && fullPath && fullPath.length > 0) {
        console.log(`🏃 Entering ESCAPE MODE after bomb - ${fullPath.length} step sequence`)
        escapeMode = true
        escapePath = [...fullPath]
        const firstMove = escapePath.shift()
        setTimeout(() => {
          smoothMove(firstMove, true)
        }, STEP_DELAY)
      } else if (
        isEscape &&
        escapeAction &&
        ["UP", "DOWN", "LEFT", "RIGHT"].includes(escapeAction)
      ) {
        // Fallback: single escape move if no full path
        console.log(`🏃 Escaping after bomb: ${escapeAction}`)
        setTimeout(() => {
          smoothMove(escapeAction)
        }, STEP_DELAY)
      }
      return
    }

    // If this is an escape decision with a full path, enter escape mode
    if (isEscape && fullPath && fullPath.length > 0) {
      console.log(`🚨 Entering ESCAPE MODE - ${fullPath.length} step sequence`)
      escapeMode = true
      escapePath = [...fullPath]
      const firstMove = escapePath.shift()
      smoothMove(firstMove, true)
      return
    }

    if (["UP", "DOWN", "LEFT", "RIGHT"].includes(action)) {
      // Check if this is a multi-step path (exploration/targeting)
      if (!isEscape && fullPath && fullPath.length > 1) {
        console.log(`🚶 Entering FOLLOW MODE - ${fullPath.length} step sequence`)
        followMode = true
        followPath = [...fullPath]
        const firstMove = followPath.shift()
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
