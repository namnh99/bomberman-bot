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
    if (coordinates.length > 0) {
      const coordStr = coordinates.map((c) => `[${c.x},${c.y}]`).join(" → ")
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
    this.escapeMode = false
    this.escapePath = []
    this.escapeCoordinates = []
  }

  completeEscape() {
    this.escapeMode = false
    this.escapePath = []
    this.escapeCoordinates = []
  }

  // Follow Mode Methods
  isFollowing() {
    return this.followMode
  }

  startFollow(path, coordinates = []) {
    if (coordinates.length > 0) {
      const coordStr = coordinates.map((c) => `[${c.x},${c.y}]`).join(" → ")
      // Path target is the final destination
      const destination = coordinates[coordinates.length - 1]
      this.pathTarget = { x: destination.x, y: destination.y }
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
    this.followMode = false
    this.followPath = []
    this.followCoordinates = []
    this.pathTarget = null
  }

  completeFollow() {
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
