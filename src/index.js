import "dotenv/config"
import socketManager from "./socket/SocketManager.js"
import { decideNextAction } from "./bot/agent.js"
import { STEP_DELAY, GRID_SIZE, BOT_SIZE } from "./utils/constants.js"
import readline from "readline"

// Import utility functions for escape path validation
import { findUnsafeTiles } from "./bot/agent.js"

const socket = socketManager.getSocket()
const offset = (GRID_SIZE - BOT_SIZE) / 2

let currentState = null
let myUid = null
let moveIntervalId = null
let alignIntervalId = null
let escapeMode = false
let escapePath = []
let manualMode = false
let useSmootMovesInManual = true
let speed = 1

// Track bomb positions for bomberPassedThrough detection
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

// ==================== SOCKET EVENTS ====================

socket.on("connect", () => {
  console.log("✅ Connected:", socket.id)
  socket.emit("join", {})
  myUid = socket.id
  setupManualControl()
})

socket.on("user", (state) => {
  currentState = state

  // Initialize tracking for existing bombs
  if (state.bombs && state.bombers) {
    // Find OUR bomber
    const myBomber = state.bombers.find((b) => b.uid === myUid)

    state.bombs.forEach((bomb) => {
      const bombGridX = Math.floor(bomb.x / GRID_SIZE)
      const bombGridY = Math.floor(bomb.y / GRID_SIZE)

      // Check if WE are currently on the bomb tile
      let weAreOnBombTile = false
      if (myBomber) {
        const myBomberGridX = Math.floor(myBomber.x / GRID_SIZE)
        const myBomberGridY = Math.floor(myBomber.y / GRID_SIZE)
        weAreOnBombTile = myBomberGridX === bombGridX && myBomberGridY === bombGridY
      }

      // Initialize bomberPassedThrough if not set
      if (bomb.bomberPassedThrough === undefined) {
        // If WE are on the bomb, we haven't passed through yet
        // If WE are not on the bomb, we already passed through (or it was placed elsewhere)
        bomb.bomberPassedThrough = !weAreOnBombTile
      }

      // Track this bomb
      if (!bombTracking.has(bomb.id)) {
        bombTracking.set(bomb.id, {
          gridX: bombGridX,
          gridY: bombGridY,
          bomberUid: bomb.uid, // Keep for reference
        })
      }
    })
  }

  // Only make decision if not in manual mode AND not currently escaping
  if (!manualMode && !escapeMode && !moveIntervalId && !alignIntervalId) {
    makeDecision()
  }
})

socket.on("player_move", (data) => {
  if (!currentState || !data.uid) return

  const bomberGridX = Math.floor(data.x / GRID_SIZE)
  const bomberGridY = Math.floor(data.y / GRID_SIZE)

  // Check ALL bombs to see if we moved away from any of them
  if (data.uid === myUid) {
    bombTracking.forEach((bombInfo, bombId) => {
      const hasMovedAway = bomberGridX !== bombInfo.gridX || bomberGridY !== bombInfo.gridY
      if (hasMovedAway) {
        // Find the bomb in currentState and update its flag
        const bomb = currentState.bombs.find((b) => b.id === bombId)
        if (bomb && !bomb.bomberPassedThrough) {
          bomb.bomberPassedThrough = true
          console.log(`   🚶 We left bomb ${bombId} at [${bombInfo.gridX}, ${bombInfo.gridY}]`)
        }
      }
    })
  }

  // Update OUR bomber's position in state
  const bomberIndex = currentState.bombers.findIndex((b) => b.uid === data.uid)
  if (bomberIndex !== -1) currentState.bombers[bomberIndex] = data
})

socket.on("new_bomb", (bomb) => {
  if (!currentState) return
  console.log(
    `💣 New bomb placed at [${Math.floor(bomb.x / GRID_SIZE)}, ${Math.floor(bomb.y / GRID_SIZE)}] | id: ${bomb.id}, bomberPassedThrough: ${bomb.bomberPassedThrough}`,
  )
  // Server provides createdAt and lifeTime, no need to set manually

  // Find OUR bomber to check if we're standing on this bomb
  const myBomber = currentState.bombers.find((b) => b.uid === myUid)
  const bombGridX = Math.floor(bomb.x / GRID_SIZE)
  const bombGridY = Math.floor(bomb.y / GRID_SIZE)

  // Check if WE are standing on the bomb tile when it's placed
  let weAreOnBombTile = false
  if (myBomber) {
    const myBomberGridX = Math.floor(myBomber.x / GRID_SIZE)
    const myBomberGridY = Math.floor(myBomber.y / GRID_SIZE)
    weAreOnBombTile = myBomberGridX === bombGridX && myBomberGridY === bombGridY
  }

  // Initialize bomberPassedThrough if server didn't provide it:
  // - false if WE are standing on bomb tile (we can walk through initially)
  // - true if WE are NOT on bomb tile (blocks us immediately)
  if (bomb.bomberPassedThrough === undefined) {
    bomb.bomberPassedThrough = !weAreOnBombTile
    console.log(
      `   🔧 Initialized bomberPassedThrough = ${bomb.bomberPassedThrough} (we ${weAreOnBombTile ? "ARE" : "are NOT"} on bomb)`,
    )
  } else {
    console.log(`   ✅ Using server's bomberPassedThrough = ${bomb.bomberPassedThrough}`)
  }

  // Track this bomb's initial position (avoid duplicates)
  if (!bombTracking.has(bomb.id)) {
    bombTracking.set(bomb.id, {
      gridX: bombGridX,
      gridY: bombGridY,
      bomberUid: bomb.uid, // Keep for reference, but not used in tracking logic anymore
    })
  }

  // const bommber = currentState.bombers.find((b) => b.uid === bomb.uid)
  // console.log(
  //   `💣 New bomb placed at [${Math.floor(bomb.x / GRID_SIZE)}, ${Math.floor(
  //     bomb.y / GRID_SIZE,
  //   )}] | bomber: [${Math.floor(bommber?.x / GRID_SIZE)}, ${Math.floor(bommber?.y / GRID_SIZE)}]`,
  // )
  currentState.bombs.push(bomb)
  // console.log(`   📊 Total bombs in state: ${currentState.bombs.length}`);

  // CRITICAL: Check if new bomb affects our escape path
  if (escapeMode && escapePath.length > 0) {
    console.log(`\n🚨 NEW BOMB during escape! Checking if escape path is still safe...`)

    const myBomber = currentState.bombers.find((b) => b.uid === myUid)
    if (myBomber) {
      const playerGridPos = {
        x: Math.floor(myBomber.x / GRID_SIZE),
        y: Math.floor(myBomber.y / GRID_SIZE),
      }

      // Check if the new bomb threatens our escape path
      const unsafeTiles = findUnsafeTiles(
        currentState.map,
        currentState.bombs,
        currentState.bombers,
      )

      // Only check if the DESTINATION (final tile) is safe
      // Waypoints can be in danger zones as long as we're passing through before explosion
      let finalX = playerGridPos.x
      let finalY = playerGridPos.y

      for (const step of escapePath) {
        if (step === "UP") finalY--
        else if (step === "DOWN") finalY++
        else if (step === "LEFT") finalX--
        else if (step === "RIGHT") finalX++
      }

      const destinationUnsafe = unsafeTiles.has(`${finalX},${finalY}`)

      if (destinationUnsafe) {
        console.log(`   ⚠️  Escape DESTINATION [${finalX}, ${finalY}] is unsafe!`)
        console.log(`   🔄 ABORT ESCAPE - Finding new escape route!`)
        // Cancel current escape
        escapeMode = false
        escapePath = []
        if (moveIntervalId) {
          clearInterval(moveIntervalId)
          moveIntervalId = null
        }
        if (alignIntervalId) {
          clearInterval(alignIntervalId)
          alignIntervalId = null
        }
        // Immediately find new escape route
        makeDecision()
      } else {
        console.log(`   ✅ Escape destination [${finalX}, ${finalY}] is safe, continuing...`)
      }
    }
  } else if (!manualMode && !escapeMode && !moveIntervalId && !alignIntervalId) {
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
  // console.log(
  //   `💥 Bomb exploded at [${Math.floor(bomb.x / GRID_SIZE)}, ${Math.floor(
  //     bomb.y / GRID_SIZE
  //   )}] | id: ${bomb.id}`
  // );
  const bombIndex = currentState.bombs.findIndex((b) => b.id === bomb.id)
  if (bombIndex !== -1) {
    // console.log(
    //   `   ✅ Removing exploded bomb from state (index: ${bombIndex})`
    // );
    currentState.bombs.splice(bombIndex, 1)
  }

  // Clean up tracking for this bomb
  bombTracking.delete(bomb.id)

  // console.log(`   📊 Remaining bombs in state: ${currentState.bombs.length}`);

  // Only re-evaluate if we're not escaping or moving
  if (!manualMode && !escapeMode && !moveIntervalId && !alignIntervalId) {
    console.log("💥 Bomb exploded, re-evaluating...")
    makeDecision() // Re-evaluate decision after an explosion
  } else if (escapeMode) {
    console.log("🏃 Escape in progress, ignoring bomb explosion event")
  }
})

socket.on("chest_destroyed", (chest) => {
  if (!currentState) return
  const chestX = Math.floor(chest.x / GRID_SIZE)
  const chestY = Math.floor(chest.y / GRID_SIZE)
  let item = null

  if (chest.item && chest.item.type) {
    switch (chest.item.type) {
      case "S":
        item = "S"
        break
      case "R":
        item = "R"
        break
      case "B":
        item = "B"
        break
    }
  }

  currentState.map[chestY][chestX] = item
  // Only re-evaluate if we're not escaping or moving
  if (!manualMode && !escapeMode && !moveIntervalId && !alignIntervalId) {
    console.log("🧱 Chest destroyed, re-evaluating...")
    makeDecision() // Re-evaluate decision after a chest is destroyed
  } else if (escapeMode) {
    console.log("🏃 Escape in progress, ignoring chest destroyed event")
  }
})

socket.on("item_collected", (data) => {
  if (!currentState) return
  const itemX = Math.floor(data.item.x / GRID_SIZE)
  const itemY = Math.floor(data.item.y / GRID_SIZE)
  currentState.map[itemY][itemX] = null

  if (data.bomber && data.bomber.uid === myUid && data.item.type === "S") {
    speed = data.bomber.speed
    console.log(`⚡ Speed increased: ${speed}`)
  }

  // TODO: Could also update bomber's attributes if needed
  // Only re-evaluate if we're not escaping or moving
  if (!manualMode && !escapeMode && !moveIntervalId && !alignIntervalId) {
    console.log("✨ Item collected, re-evaluating...")
    makeDecision() // Re-evaluate decision after an item is collected
  } else if (escapeMode) {
    console.log("🏃 Escape in progress, ignoring item collected event")
  }
})

socket.on("map_update", (data) => {
  if (!currentState) return
  currentState.chests = data.chests
  currentState.items = data.items
  // makeDecision(); // Re-evaluate decision after map update
})

// ==================== ACTION HELPERS ====================

function move(direction) {
  socket.emit("move", { orient: direction })
}

function placeBomb() {
  // console.log("💣 Place bomb");
  socket.emit("place_bomb", {})
}

const smoothMove = (direction, isEscapeMove = false) => {
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

  const currentBomber = currentState.bombers.find((b) => b.uid === myUid)
  const currentX = currentBomber ? currentBomber.x : null
  const currentY = currentBomber ? currentBomber.y : null
  let pixelsToMove = 0
  let i = 0

  console.log(
    `\n🏃 Smooth move requested: ${direction} Current Pixel: [${currentX}, ${currentY}] | grid: [${Math.floor(
      currentX / GRID_SIZE,
    )}, ${Math.floor(currentY / GRID_SIZE)}]`,
  )

  // Calculate pixels to move based on direction
  switch (direction) {
    case "UP":
      pixelsToMove = (currentY % GRID_SIZE) + GRID_SIZE - offset
      break
    case "DOWN":
      pixelsToMove = GRID_SIZE - (currentY % GRID_SIZE) + offset
      break
    case "LEFT":
      pixelsToMove = (currentX % GRID_SIZE) + GRID_SIZE - offset
      break
    case "RIGHT":
      pixelsToMove = GRID_SIZE - (currentX % GRID_SIZE) + offset
      break
  }

  let stepsNeeded = Math.ceil(pixelsToMove / speed)

  // Calculate steps based on speed: each emit moves (speed) pixels
  const moveLabel = isEscapeMove ? "🏃 ESCAPE move" : "🏃 Starting smooth move"
  console.log(`${moveLabel}: ${direction} (speed: ${speed}, pixels: ${pixelsToMove})`)

  moveIntervalId = setInterval(() => {
    if (i < stepsNeeded) {
      // console.log(`   ➡️  Move step ${i + 1}/${stepsNeeded} (${direction})`)
      move(direction)
      i++
    } else {
      clearInterval(moveIntervalId)
      moveIntervalId = null
      i = 0
      // console.log(`✅ Move complete: ${direction}`)

      // If in escape mode, continue with next step or exit escape mode
      if (escapeMode && escapePath.length > 0) {
        const nextMove = escapePath.shift()
        console.log(`🏃 Continuing escape: ${nextMove} (${escapePath.length} steps remaining)`)
        // Small delay between escape moves to ensure position updates
        setTimeout(() => {
          smoothMove(nextMove, true)
        }, 50)
      } else {
        // Escape complete or normal move done
        if (escapeMode) {
          console.log(`✅ Escape sequence completed!`)
          escapeMode = false
          escapePath = []
          console.log(`   ⏸️  Waiting before next decision to ensure safety...`)
          // Wait for bombs to explode before re-evaluating
          setTimeout(() => {
            console.log(`   🔍 Re-evaluating safety after escape...`)
            makeDecision()
          }, GRID_SIZE / speed)
          return // Don't call makeDecision immediately
        }
        // Normal move completed, make new decision
        setTimeout(() => {
          makeDecision()
        }, STEP_DELAY) // Small delay to let position update
      }
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
      console.log(`💣 Placing bomb`)
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
      // Align to grid if not already aligned before moving
      let moveOver = 0
      let alignDirection = null
      if (action === "UP" || action === "DOWN") {
        // Check horizontal alignment (X-axis)
        const xOffset = (myBomber.x % GRID_SIZE) - offset
        if (Math.abs(xOffset) > 0.5) {
          // Not aligned, need to move horizontally
          if (xOffset > 0) {
            // Too far right, move LEFT
            alignDirection = "LEFT"
            moveOver = Math.abs(xOffset)
          } else {
            // Too far left, move RIGHT
            alignDirection = "RIGHT"
            moveOver = Math.abs(xOffset)
          }
        }
      } else if (action === "LEFT" || action === "RIGHT") {
        // Check vertical alignment (Y-axis)
        const yOffset = (myBomber.y % GRID_SIZE) - offset
        if (Math.abs(yOffset) > 0.5) {
          // Not aligned, need to move vertically
          if (yOffset > 0) {
            // Too far down, move UP
            alignDirection = "UP"
            moveOver = Math.abs(yOffset)
          } else {
            // Too far up, move DOWN
            alignDirection = "DOWN"
            moveOver = Math.abs(yOffset)
          }
        }
      }
      // Execute alignment before main move
      // Note: Always align when moving perpendicular, even if misalignment is small
      // The server may reject movement if not properly aligned
      if (moveOver > 0 && alignDirection) {
        // Calculate alignment steps based on global speed
        const alignSteps = Math.ceil(moveOver / speed)
        let stepsLeft = alignSteps
        console.log(
          `🔧 Aligning ${alignDirection} (${moveOver.toFixed(1)}px in ${alignSteps} steps, speed: ${speed}) before moving ${action}`,
        )
        alignIntervalId = setInterval(() => {
          if (stepsLeft > 0) {
            socket.emit("move", { orient: alignDirection })
            stepsLeft--
          } else {
            clearInterval(alignIntervalId)
            alignIntervalId = null
            console.log(`✅ Alignment complete, starting move: ${action}`)
            // Wait for server to send updated position before starting main move
            setTimeout(() => {
              smoothMove(action)
            }, 50) // Wait 50ms (~3 server ticks) for position update
          }
        }, STEP_DELAY)
      } else {
        // Already perfectly aligned, move directly
        console.log(`✅ Already aligned, moving: ${action}`)
        smoothMove(action)
      }
    } else if (action === "STAY") {
      console.log(`⏸️  Staying put`)
      // setTimeout(() => {
      //   makeDecision()
      // }, 500)
    }
  } catch (err) {
    console.error("⚠️ Decision error:", err)
  }
}
