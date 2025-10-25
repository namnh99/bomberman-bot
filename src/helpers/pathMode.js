/**
 * Path mode manager - handles escape and follow modes
 */
export class PathModeManager {
  constructor() {
    this.escapeMode = false
    this.escapePath = []
    this.followMode = false
    this.followPath = []
  }

  // Escape Mode Methods
  isEscaping() {
    return this.escapeMode
  }

  startEscape(path) {
    console.log(`🚨 Entering ESCAPE MODE - ${path.length} step sequence`)
    this.escapeMode = true
    this.escapePath = [...path]
  }

  getNextEscapeMove() {
    return this.escapePath.shift()
  }

  getRemainingEscapeSteps() {
    return this.escapePath.length
  }

  abortEscape(reason = "Path blocked") {
    console.log(`   🚨 ABORTING ESCAPE - ${reason}!`)
    this.escapeMode = false
    this.escapePath = []
  }

  completeEscape() {
    console.log(`✅ Escape sequence completed!`)
    this.escapeMode = false
    this.escapePath = []
  }

  // Follow Mode Methods
  isFollowing() {
    return this.followMode
  }

  startFollow(path) {
    console.log(`🚶 Entering FOLLOW MODE - ${path.length} step sequence`)
    this.followMode = true
    this.followPath = [...path]
  }

  getNextFollowMove() {
    return this.followPath.shift()
  }

  getRemainingFollowSteps() {
    return this.followPath.length
  }

  abortFollow(reason = "Path blocked") {
    console.log(`   🚨 ABORTING FOLLOW PATH - ${reason}!`)
    this.followMode = false
    this.followPath = []
  }

  completeFollow() {
    console.log(`✅ Follow path completed!`)
    this.followMode = false
    this.followPath = []
  }

  // General Methods
  isInAnyMode() {
    return this.escapeMode || this.followMode
  }

  clearAll() {
    this.escapeMode = false
    this.escapePath = []
    this.followMode = false
    this.followPath = []
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
