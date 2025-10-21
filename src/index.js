import "dotenv/config"
import socketManager from "./socket/SocketManager.js"
import { decideNextAction } from "./bot/bomberman_beam_agent.js"
import { STEP_DELAY, STEP_COUNT } from "./constants/index.js"
import readline from "readline"

const socket = socketManager.getSocket()

let currentState = null
let myUid = null
let moveIntervalId = null
let alignIntervalId = null
let escapeMode = false
let escapePath = []
let manualMode = false // Toggle between manual and AI control
let useSmootMovesInManual = true // Use smooth moves in manual mode (false = single steps)
let speed = 1

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
    console.log(`🔑 Key pressed: ${key?.name || str} (ctrl: ${key?.ctrl})`) // Debug log

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
        `   Current: [${Math.floor(myBomber.x / STEP_COUNT)}, ${Math.floor(myBomber.y / STEP_COUNT)}] | Pixel: [${myBomber.x}, ${myBomber.y}]`,
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
        smoothMove(action, speed, false)
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
  if (!manualMode) {
    makeDecision()
  }
})

socket.on("player_move", (data) => {
  if (!currentState) return
  // Mock to my bomber
  const bomberIndex = currentState.bombers.findIndex((b) => b.uid === data.uid)
  if (bomberIndex !== -1) {
    currentState.bombers[bomberIndex] = data
    // Update global speed when our bomber's speed changes
    if (data.uid === myUid && data.speed) {
      speed = data.speed
      console.log(`⚡ Speed updated: ${speed}`)
    }
    // Log position updates for debugging
    if (data.uid === myUid) {
      // console.log(
      //   `🔄 Position updated: [${Math.floor(data.x / STEP_COUNT)}, ${Math.floor(
      //     data.y / STEP_COUNT
      //   )}] | Pixel: [${data.x}, ${data.y}]`
      // );
    }
  }
})

socket.on("new_bomb", (bomb) => {
  if (!currentState) return
  const bommber = currentState.bombers.find((b) => b.uid === bomb.uid)
  // console.log(
  //   `💣 New bomb placed at [${Math.floor(bomb.x / STEP_COUNT)}, ${Math.floor(
  //     bomb.y / STEP_COUNT,
  //   )}] | bomber: [${Math.floor(bommber?.x / STEP_COUNT)}, ${Math.floor(bommber?.y / STEP_COUNT)}]`,
  // )
  currentState.bombs.push(bomb)
  // console.log(`   � Total bombs in state: ${currentState.bombs.length}`);
  if (!manualMode) {
    makeDecision() // Re-evaluate decision when a new bomb appears
  }
})

socket.on("bomb_explode", (bomb) => {
  if (!currentState) return
  // console.log(
  //   `💥 Bomb exploded at [${Math.floor(bomb.x / STEP_COUNT)}, ${Math.floor(
  //     bomb.y / STEP_COUNT
  //   )}] | id: ${bomb.id}`
  // );
  const bombIndex = currentState.bombs.findIndex((b) => b.id === bomb.id)
  if (bombIndex !== -1) {
    // console.log(
    //   `   ✅ Removing exploded bomb from state (index: ${bombIndex})`
    // );
    currentState.bombs.splice(bombIndex, 1)
  }
  // console.log(`   📊 Remaining bombs in state: ${currentState.bombs.length}`);
  if (!manualMode) {
    makeDecision() // Re-evaluate decision after an explosion
  }
})

socket.on("chest_destroyed", (chest) => {
  if (!currentState) return
  const chestX = Math.floor(chest.x / STEP_COUNT)
  const chestY = Math.floor(chest.y / STEP_COUNT)
  let item = null

  if (chest.item?.type) {
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
  if (!manualMode) {
    makeDecision() // Re-evaluate decision after a chest is destroyed
  }
})

socket.on("item_collected", (data) => {
  if (!currentState) return
  const itemX = Math.floor(data.item.x / STEP_COUNT)
  const itemY = Math.floor(data.item.y / STEP_COUNT)
  currentState.map[itemY][itemX] = null

  if (data.bomber.uid === myUid && data.item.type === "S") {
    speed += 1
    console.log(`⚡ Speed increased: ${speed}`)
  }

  // TODO: Could also update bomber's attributes if needed
  if (!manualMode) {
    makeDecision() // Re-evaluate decision after an item is collected
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

const smoothMove = (direction, speed = 1, isEscapeMove = false) => {
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
  const currentX = currentBomber?.x
  const currentY = currentBomber?.y
  let pixelsToMove = STEP_COUNT
  let i = 0

  console.log(
    `\n🏃 Smooth move requested: ${direction} Current Pixel: [${currentX}, ${currentY}] | grid: [${Math.floor(
      currentX / STEP_COUNT,
    )}, ${Math.floor(currentY / STEP_COUNT)}]`,
  )



  // Calculate pixels to move based on direction
  switch (direction) {
    case "UP":
      pixelsToMove = currentY % STEP_COUNT + STEP_COUNT
      break
    case "DOWN":
      pixelsToMove = STEP_COUNT - (currentY % STEP_COUNT)
      break
    case "LEFT":
      pixelsToMove = currentX % STEP_COUNT + STEP_COUNT
      break
    case "RIGHT":
      pixelsToMove = STEP_COUNT - (currentX % STEP_COUNT)
      break
  }

  let stepsNeeded = Math.ceil(pixelsToMove / speed)

  // Calculate steps based on speed: each emit moves (speed) pixels
  const moveLabel = isEscapeMove ? "🏃 ESCAPE move" : "🏃 Starting smooth move"
  console.log(`${moveLabel}: ${direction} (speed: ${speed}, pixels: ${pixelsToMove})`)

  moveIntervalId = setInterval(() => {
    if (i < stepsNeeded) {
      console.log(`   ➡️  Move step ${i + 1}/${stepsNeeded} (${direction})`)
      move(direction)
      i++
    } else {
      clearInterval(moveIntervalId)
      moveIntervalId = null
      i = 0
      console.log(`✅ Move complete: ${direction}`)

      // If in escape mode, continue with next step or exit escape mode
      if (escapeMode && escapePath.length > 0) {
        const nextMove = escapePath.shift()
        console.log(`🏃 Continuing escape: ${nextMove} (${escapePath.length} pixels remaining)`)
        smoothMove(nextMove, speed, true)
      } else {
        // Escape complete or normal move done
        // if (escapeMode) {
        //   console.log(`✅ Escape sequence completed!`);
        //   escapeMode = false;
        //   escapePath = [];
        //   console.log(
        //     `   ⏸️ Waiting briefly before next decision (bombs may still be active)...`
        //   );
        //   // Wait a bit before making next decision to avoid re-entering danger zones
        //   // The bomb that caused the escape might still be active
        //   setTimeout(() => {
        //     makeDecision();
        //   }, 500); // 500ms delay to let bombs explode
        //   return; // Don't call makeDecision immediately
        // }
        makeDecision()
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

  // If in escape mode, don't interrupt - let escape sequence complete
  if (escapeMode && (moveIntervalId || alignIntervalId)) {
    console.log(`🏃 Escape in progress... (${escapePath.length} steps remaining)`)
    return
  }

  // Don't make new decisions if a move is already in progress (unless canceling it)
  if (moveIntervalId || alignIntervalId) {
    console.log("⏸️  Move in progress, canceling to make new decision")
    clearInterval(moveIntervalId)
    moveIntervalId = null
    clearInterval(alignIntervalId)
    alignIntervalId = null
  }

  const myBomber = currentState.bombers.find((b) => b.uid === myUid)
  if (!myBomber) return

  console.log(
    `\n📍 Position: [${Math.floor(myBomber.x / STEP_COUNT)}, ${Math.floor(
      myBomber.y / STEP_COUNT,
    )}] | Pixel: [${myBomber.x}, ${myBomber.y}] | Orient: ${myBomber.orient}`,
  )

  try {
    const decision = decideNextAction(currentState, myUid)
    const { action, escapeAction, isEscape, fullPath } = decision

    console.log("trigger", action, escapeAction, isEscape, fullPath)

    // If this is an escape decision with a full path, enter escape mode
    if (isEscape && fullPath && fullPath.length > 1) {
      console.log(`🚨 Entering ESCAPE MODE - ${fullPath.length} step sequence`)
      escapeMode = true
      escapePath = [...fullPath] // Copy the full path
      const firstMove = escapePath.shift() // Remove first move from queue
      smoothMove(firstMove, speed, true)
      return
    }

    if (["UP", "DOWN", "LEFT", "RIGHT"].includes(action)) {
      // Align to grid if not already aligned before moving
      // let moveOver = 0;
      // let alignDirection = null;

      // if (action === "UP" || action === "DOWN") {
      //   moveOver = myBomber.x % STEP_COUNT;
      //   if (moveOver !== 0) {
      //     // Choose shortest path to align
      //     if (moveOver > STEP_COUNT / 2) {
      //       alignDirection = "RIGHT";
      //       moveOver = STEP_COUNT - moveOver;
      //     } else {
      //       alignDirection = "LEFT";
      //     }
      //   }
      // } else if (action === "LEFT" || action === "RIGHT") {
      //   moveOver = myBomber.y % STEP_COUNT;
      //   if (moveOver !== 0) {
      //     // Choose shortest path to align
      //     if (moveOver > STEP_COUNT / 2) {
      //       alignDirection = "DOWN";
      //       moveOver = STEP_COUNT - moveOver;
      //     } else {
      //       alignDirection = "UP";
      //     }
      //   }
      // }

      // // Execute alignment before main move
      // // Note: Always align when moving perpendicular, even if misalignment is small
      // // The server may reject movement if not properly aligned
      // if (moveOver > 0 && alignDirection) {
      //   // Calculate alignment steps based on speed
      //   const alignSteps = Math.ceil(moveOver / myBomber.speed);
      //   let stepsLeft = alignSteps;
      //   console.log(
      //     `🔧 Aligning ${alignDirection} (${moveOver}px in ${alignSteps} steps, speed: ${myBomber.speed}) before moving ${action}`
      //   );

      //   alignIntervalId = setInterval(() => {
      //     if (stepsLeft > 0) {
      //       socket.emit("move", { orient: alignDirection });
      //       stepsLeft--;
      //     } else {
      //       clearInterval(alignIntervalId);
      //       alignIntervalId = null;
      //       console.log(`✅ Alignment complete, starting move: ${action}`);
      //       // Start main move after alignment
      //       smoothMove(action, myBomber.speed);
      //     }
      //   }, STEP_DELAY);
      // } else {
      //   // Already perfectly aligned, move directly
      //   console.log(`✅ Already aligned, moving: ${action}`);
      //   smoothMove(action, speed);
      // }

      smoothMove(action, speed)
    } else if (action === "BOMB") {
      console.log(`💣 Placing bomb`)
      placeBomb()
      // After placing a bomb, immediately start moving to the safe zone
      if (escapeAction && ["UP", "DOWN", "LEFT", "RIGHT"].includes(escapeAction)) {
        console.log(`🏃 Escaping: ${escapeAction}`)
        // Use a small delay to allow the bomb placement to register before moving
        setTimeout(() => {
          smoothMove(escapeAction, speed)
        }, STEP_DELAY)
      }
    } else if (action === "STAY") {
      console.log(`⏸️  Staying put`)
    }
  } catch (err) {
    console.error("⚠️ Decision error:", err)
  }
}
