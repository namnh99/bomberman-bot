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
    return this.manualMode
  }

  toggleMovementType() {
    this.useSmootMovesInManual = !this.useSmootMovesInManual
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

  // Setup readline for keyboard input
  readline.emitKeypressEvents(process.stdin)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  } else {
  }

  process.stdin.on("keypress", (str, key) => {
    // Handle Ctrl+C to exit
    if (key && key.ctrl && key.name === "c") {
      process.exit()
    }

    // Handle quit
    if (key && key.name === "q") {
      process.exit()
    }

    // Get current state
    const { currentState, myUid } = getCurrentState()

    // Need game state for movement commands
    if (!currentState || !myUid) {
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
        onBomb()
        return
    }

    if (action) {

      onMove(action, manualControlManager.useSmoothMoves())
    }
  })
}
