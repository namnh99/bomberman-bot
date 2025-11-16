/**
 * Move Queue Manager
 * Prevents spamming moves to server by queuing and confirming each move
 */

import { STEP_DELAY } from "../utils/constants.js"

class MoveQueueManager {
  constructor() {
    this.queue = []
    this.pendingMove = null
    this.isProcessing = false
    this.lastMoveTime = 0
    this.moveCount = 0
    this.confirmedMoves = 0
    this.MIN_MOVE_INTERVAL = 5 // 5ms minimal throttle - effectively no delay, just prevents true burst
  }

  /**
   * Add a move to the queue
   */
  enqueue(direction, priority = "normal") {
    // Don't queue duplicate consecutive moves
    const lastInQueue = this.queue[this.queue.length - 1]
    if (lastInQueue && lastInQueue.direction === direction && lastInQueue.priority === priority) {
      return
    }

    this.queue.push({
      direction,
      priority, // 'high' | 'normal' | 'low'
      timestamp: Date.now(),
      id: ++this.moveCount,
    })


    // Start processing if not already
    if (!this.isProcessing) {
      this.processQueue()
    }
  }

  /**
   * Process the queue
   */
  async processQueue() {
    if (this.isProcessing) return
    if (this.queue.length === 0) return

    this.isProcessing = true

    while (this.queue.length > 0) {
      // Check if we need to wait before sending next move
      const now = Date.now()
      const timeSinceLastMove = now - this.lastMoveTime

      if (timeSinceLastMove < this.MIN_MOVE_INTERVAL) {
        const waitTime = this.MIN_MOVE_INTERVAL - timeSinceLastMove
        await this.sleep(waitTime)
      }

      // Get next move (priority: high > normal > low)
      const move = this.getNextMove()
      if (!move) break

      // Send the move
      this.pendingMove = move
      this.lastMoveTime = Date.now()


      // Emit to server (will be set by init)
      if (this.socket) {
        this.socket.emit("move", { orient: move.direction })
      }

      // Don't wait for confirmation - let server handle it
      // Confirmation tracking is optional (for stats only)
      this.pendingMove = move

      // Optional: Track confirmation asynchronously (non-blocking)
      this.waitForConfirmation(100).then((confirmed) => {
        if (confirmed) {
          this.confirmedMoves++
        }
      })

      this.pendingMove = null
    }

    this.isProcessing = false
  }

  /**
   * Get next move from queue (priority order)
   */
  getNextMove() {
    if (this.queue.length === 0) return null

    // Find highest priority move
    const priorities = { high: 3, normal: 2, low: 1 }
    let bestIndex = 0
    let bestPriority = 0

    for (let i = 0; i < this.queue.length; i++) {
      const priority = priorities[this.queue[i].priority] || 2
      if (priority > bestPriority) {
        bestPriority = priority
        bestIndex = i
      }
    }

    // Remove and return
    return this.queue.splice(bestIndex, 1)[0]
  }

  /**
   * Wait for move confirmation from server
   */
  waitForConfirmation(timeout) {
    return new Promise((resolve) => {
      const moveId = this.pendingMove?.id

      // Set timeout
      const timeoutId = setTimeout(() => {
        this.confirmCallbacks.delete(moveId)
        resolve(false)
      }, timeout)

      // Store callback
      this.confirmCallbacks.set(moveId, () => {
        clearTimeout(timeoutId)
        resolve(true)
      })
    })
  }

  /**
   * Confirm a move (called by position update handler)
   */
  confirmMove() {
    if (!this.pendingMove) return

    const callback = this.confirmCallbacks.get(this.pendingMove.id)
    if (callback) {
      callback()
      this.confirmCallbacks.delete(this.pendingMove.id)
    }
  }

  /**
   * Clear the queue (for emergency stops)
   */
  clear() {
    this.queue = []
    this.pendingMove = null
    this.isProcessing = false
  }

  /**
   * Abort current pending move and clear queue
   * Use this when interrupting movement (e.g., changing direction)
   */
  abort(reason = "Movement aborted") {
    this.queue = []
    // Don't clear pendingMove - let it complete to avoid desync
    // Just stop processing new moves
    this.isProcessing = false
  }

  /**
   * Get queue status
   */
  getStatus() {
    return {
      queueSize: this.queue.length,
      isPending: !!this.pendingMove,
      isProcessing: this.isProcessing,
      totalMoves: this.moveCount,
      confirmedMoves: this.confirmedMoves,
      successRate:
        this.moveCount > 0 ? ((this.confirmedMoves / this.moveCount) * 100).toFixed(1) + "%" : "0%",
    }
  }

  /**
   * Initialize with socket
   */
  init(socket) {
    this.socket = socket
    this.confirmCallbacks = new Map()
  }

  /**
   * Helper: sleep
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.moveCount = 0
    this.confirmedMoves = 0
  }
}

// Singleton instance
export const moveQueue = new MoveQueueManager()
