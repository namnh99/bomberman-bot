import readline from "readline"
import { GRID_SIZE } from "../utils/constants.js"

/**
 * Manual control manager
 */
export class ManualControlManager {
  constructor() {
    this.manualMode = false
    this.useSmootMovesInManual = true
  }

  isManualMode() {
    return this.manualMode
  }

  toggleMode() {
    this.manualMode = !this.manualMode
    console.log(
      `\n🔄 Mode switched to: ${this.manualMode ? "🎮 MANUAL CONTROL" : "🤖 AI CONTROL"}\n`,
    )
    return this.manualMode
  }

  toggleMovementType() {
    this.useSmootMovesInManual = !this.useSmootMovesInManual
    console.log(
      `\n🔄 Movement type: ${this.useSmootMovesInManual ? "📏 Smooth (full cell)" : "👣 Step-by-step"}\n`,
    )
    return this.useSmootMovesInManual
  }

  useSmoothMoves() {
    return this.useSmootMovesInManual
  }
}

/**
 * Setup manual control keyboard listener
 */
export function setupManualControl(
  manualControlManager,
  onMove,
  onBomb,
  onModeToggle,
  getCurrentState,
) {
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
  console.log(`Current Mode: ${manualControlManager.isManualMode() ? "🎮 MANUAL" : "🤖 AI"}`)
  console.log(
    `Movement Type: ${manualControlManager.useSmoothMoves() ? "📏 Smooth (full cell)" : "👣 Step-by-step"}`,
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

    // Get current state
    const { currentState, myUid } = getCurrentState()

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
      const isManual = manualControlManager.toggleMode()
      if (!isManual) {
        // Switched to AI mode
        onModeToggle()
      }
      return
    }

    // Toggle smooth/step movement in manual mode
    if (key && key.name === "t") {
      manualControlManager.toggleMovementType()
      return
    }

    // Only process movement keys in manual mode
    if (!manualControlManager.isManualMode()) return

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
        onBomb()
        return
    }

    if (action) {
      console.log(`\n🎮 Manual control: ${action}`)
      console.log(
        `   Current: [${Math.floor(myBomber.x / GRID_SIZE)}, ${Math.floor(myBomber.y / GRID_SIZE)}] | Pixel: [${myBomber.x}, ${myBomber.y}]`,
      )

      onMove(action, manualControlManager.useSmoothMoves())
    }
  })
}
