/**
 * Path mode manager - handles escape and follow modes
 */
export class PathModeManager {
  constructor() {
    this.escapeMode = false
    this.escapePath = []
    this.escapeCoordinates = []
    this.followMode = false
    this.followPath = []
    this.followCoordinates = []
    this.pathTarget = null // Track target {x, y, type: 'item'|'chest'|'enemy'}
  }

  // Escape Mode Methods
  isEscaping() {
    return this.escapeMode
  }

  startEscape(path, coordinates = []) {
    console.log(`🚨 Entering ESCAPE MODE - ${path.length} step sequence`)
    if (coordinates.length > 0) {
      const coordStr = coordinates.map((c) => `[${c.x},${c.y}]`).join(" → ")
      console.log(`   Waypoints: ${coordStr}`)
    }
    this.escapeMode = true
    this.escapePath = [...path]
    this.escapeCoordinates = [...coordinates]
  }

  getNextEscapeMove() {
    this.escapeCoordinates.shift() // Remove first coordinate too
    return this.escapePath.shift()
  }

  getRemainingEscapeSteps() {
    return this.escapePath.length
  }

  getEscapeCoordinates() {
    return this.escapeCoordinates
  }

  getEscapeDestination() {
    if (this.escapeCoordinates.length === 0) return null
    return this.escapeCoordinates[this.escapeCoordinates.length - 1]
  }

  abortEscape(reason = "Path blocked") {
    console.log(`   🚨 ABORTING ESCAPE - ${reason}!`)
    this.escapeMode = false
    this.escapePath = []
    this.escapeCoordinates = []
  }

  completeEscape() {
    console.log(`✅ Escape sequence completed!`)
    this.escapeMode = false
    this.escapePath = []
    this.escapeCoordinates = []
  }

  // Follow Mode Methods
  isFollowing() {
    return this.followMode
  }

  startFollow(path, coordinates = []) {
    console.log(`🚶 Entering FOLLOW MODE - ${path.length} step sequence`)
    if (coordinates.length > 0) {
      const coordStr = coordinates.map((c) => `[${c.x},${c.y}]`).join(" → ")
      console.log(`   Waypoints: ${coordStr}`)
      // Path target is the final destination
      const destination = coordinates[coordinates.length - 1]
      this.pathTarget = { x: destination.x, y: destination.y }
      console.log(`   Target destination: [${this.pathTarget.x},${this.pathTarget.y}]`)
    } else {
      this.pathTarget = null
    }
    this.followMode = true
    this.followPath = [...path]
    this.followCoordinates = [...coordinates]
  }

  getNextFollowMove() {
    this.followCoordinates.shift() // Remove first coordinate too
    return this.followPath.shift()
  }

  getRemainingFollowSteps() {
    return this.followPath.length
  }

  getFollowCoordinates() {
    return this.followCoordinates
  }

  abortFollow(reason = "Path blocked") {
    console.log(`   🚨 ABORTING FOLLOW PATH - ${reason}!`)
    this.followMode = false
    this.followPath = []
    this.followCoordinates = []
    this.pathTarget = null
  }

  completeFollow() {
    console.log(`✅ Follow path completed!`)
    this.followMode = false
    this.followPath = []
    this.followCoordinates = []
    this.pathTarget = null
  }

  // General Methods
  isInAnyMode() {
    return this.escapeMode || this.followMode
  }

  clearAll() {
    this.escapeMode = false
    this.escapePath = []
    this.escapeCoordinates = []
    this.followMode = false
    this.followPath = []
    this.followCoordinates = []
    this.pathTarget = null
  }

  getStatus() {
    if (this.escapeMode) {
      return {
        mode: "escape",
        stepsRemaining: this.escapePath.length,
      }
    }
    if (this.followMode) {
      return {
        mode: "follow",
        stepsRemaining: this.followPath.length,
      }
    }
    return {
      mode: "none",
      stepsRemaining: 0,
    }
  }
}
