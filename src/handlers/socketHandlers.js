import { ITEMS, DIRS } from "../utils/constants.js"
import { toGridCoords } from "../utils/gridUtils.js"
import { getBombWithGrid } from "../utils/bombUtils.js"
import { findUnsafeTiles } from "../bot/agent.js"
import { isPathSafeByTime } from "../bot/pathfinding/safetyEvaluator.js"
import {
  updateBomberPosition,
  updateBomberAttributes,
  addBomb,
  removeBomb,
  updateMapAfterChestDestroy,
  updateMapAfterItemCollect,
  getBomber,
  isBomberOnBombTile,
} from "../helpers/gameState.js"
import { moveQueue } from "../helpers/moveQueue.js"

/**
 * Register all socket event handlers
 */
export function registerSocketHandlers(
  socket,
  gameContext,
  pathModeManager,
  bombTracker,
  manualControlManager,
  onMakeDecision,
  onSetupManualControl,
) {
  // Connection handler
  socket.on("connect", () => {
    socket.emit("join", {})
    gameContext.myUid = socket.id

    // Initialize move queue with socket
    moveQueue.init(socket)

    onSetupManualControl()
  })

  // Game start handler - wait for this before making any decisions
  socket.on("start", (data) => {
    // Make initial decision when game starts
    if (gameContext.currentState && !manualControlManager.isManualMode()) {
      onMakeDecision()
    }
  })

  // User state update handler
  socket.on("user", (state) => {
    gameContext.currentState = state
    // Only make decision if not in manual mode AND not currently escaping
    // if (
    //   !manualControlManager.isManualMode() &&
    //   !pathModeManager.isEscaping() &&
    //   !gameContext.moveIntervalId &&
    //   !gameContext.alignIntervalId
    // ) {
    //   onMakeDecision()
    // }
  })

  // Player move handler
  socket.on("player_move", (data) => {
    if (!gameContext.currentState || !data.uid) return
    const { x: bomberX, y: bomberY } = toGridCoords(data.x, data.y)

    if (data.uid === gameContext.myUid) {
      bombTracker.forEach((bombInfo, bombId) => {
        const hasMovedAway = bomberX !== bombInfo.gridX || bomberY !== bombInfo.gridY
        if (hasMovedAway) {
          bombTracker.remove(bombId)

          // Find the bomb in currentState and update its flag when bot moves away
          const bomb = gameContext.currentState.bombs.find((b) => b.id === bombId)
          if (bomb && bomb.walkable) bomb.walkable = false
        }
      })
    }

    // Update bomber's position in state
    updateBomberPosition(gameContext.currentState, data.uid, data.x, data.y)

    // Confirm move if this is our bomber
    if (data.uid === gameContext.myUid) {
      moveQueue.confirmMove()

      // Log queue status periodically
      const status = moveQueue.getStatus()
      // if (status.totalMoves % 10 === 0) {
      // }
    }
  })

  // New bomb handler
  socket.on("new_bomb", (bomb) => {
    if (!gameContext.currentState) return

    // const now = Date.now()

    const myBomber = getBomber(gameContext.currentState, gameContext.myUid)
    const { gridX, gridY } = getBombWithGrid(bomb)

    // Check if Bot is standing on the bomb tile when it's placed
    // ONLY set walkable if Bot is on the bomb tile
    let botOnTheBomb = false
    if (myBomber) botOnTheBomb = isBomberOnBombTile(myBomber, gridX, gridY)
    bomb.walkable = botOnTheBomb

    if (!bombTracker.has(bomb.id) && botOnTheBomb) {
      bombTracker.add(bomb.id, gridX, gridY, bomb.uid)
    }
    addBomb(gameContext.currentState, bomb)

    if (bomb.uid !== gameContext.myUid) {
      // CRITICAL: Check if new bomb affects our paths
      handleNewBombDuringPath(gameContext, pathModeManager, manualControlManager, onMakeDecision)
    }
  })

  // Bomb explode handler
  socket.on("bomb_explode", (bomb) => {
    if (!gameContext.currentState) return
    removeBomb(gameContext.currentState, bomb.id)
    if (bombTracker.has(bomb.id)) bombTracker.remove(bomb.id)

    handleBombExplodeDuringPath(gameContext, pathModeManager, manualControlManager, onMakeDecision)
  })

  // Chest destroyed handler
  socket.on("chest_destroyed", (chest) => {
    if (!gameContext.currentState) return
    const { x: chestX, y: chestY } = toGridCoords(chest.x, chest.y)
    let item = null

    if (chest.item && ITEMS.includes(chest.item?.type)) item = chest.item.type
    updateMapAfterChestDestroy(gameContext.currentState, chestX, chestY, item)

    handleChestDestroyedDuringPath(
      gameContext,
      pathModeManager,
      manualControlManager,
      onMakeDecision,
    )
  })

  // Item collected handler
  socket.on("item_collected", (data) => {
    if (!gameContext.currentState) return
    const { x: itemX, y: itemY } = toGridCoords(data.item.x, data.item.y)
    updateMapAfterItemCollect(gameContext.currentState, itemX, itemY)

    const bomber = getBomber(gameContext.currentState, data.bomber?.uid)
    if (bomber && bomber.uid === gameContext.myUid) {
      updateBomberAttributes(gameContext.currentState, bomber.uid, data)
      pathModeManager.completeEscape()
      pathModeManager.completeFollow()
      gameContext.forceClearIntervals()
      onMakeDecision()
    }
  })

  // Map update handler
  socket.on("map_update", (data) => {
    if (!gameContext.currentState) return
    gameContext.currentState.chests = data.chests
    gameContext.currentState.items = data.items
  })

  socket.on("user_die_update", (data) => {
    if (!gameContext.currentState) return
    gameContext.currentState.bombers = data.bombers
  })

  socket.on("new_life", (data) => {
    if (!gameContext.currentState) return
    gameContext.currentState.bombers = data.bombers
  })
}

/**
 * Handle new bomb during path execution
 */
function handleNewBombDuringPath(
  gameContext,
  pathModeManager,
  manualControlManager,
  onMakeDecision,
) {
  // Check escape path first (highest priority)
  if (pathModeManager.isEscaping() && pathModeManager.getRemainingEscapeSteps() > 0) {
    const myBomber = getBomber(gameContext.currentState, gameContext.myUid)
    if (myBomber) {
      const escapePath = pathModeManager.escapePath
      const escapeCoordinates = pathModeManager.getEscapeCoordinates()

      // Validate timing for entire escape path
      const isSafe = isPathSafeByTime(
        escapeCoordinates,
        gameContext.currentState.bombs,
        gameContext.currentState.bombers,
        gameContext.currentState.map,
        myBomber.speed || 1,
        "ESCAPE",
      )

      if (!isSafe) {
        pathModeManager.abortEscape("Path blocked by new bomb - timing unsafe")
        gameContext.forceClearIntervals()
        onMakeDecision()
      } else {
      }
    }
  }
  // Check follow path (lower priority)
  else if (pathModeManager.isFollowing() && pathModeManager.getRemainingFollowSteps() > 0) {
    const myBomber = getBomber(gameContext.currentState, gameContext.myUid)
    if (myBomber) {
      const followPath = pathModeManager.followPath
      const followCoordinates = pathModeManager.getFollowCoordinates()

      // Validate timing for entire follow path
      const isSafe = isPathSafeByTime(
        followCoordinates,
        gameContext.currentState.bombs,
        gameContext.currentState.bombers,
        gameContext.currentState.map,
        myBomber.speed || 1,
        "FOLLOW",
      )

      if (!isSafe) {
        pathModeManager.abortFollow("Path crosses bomb zone with unsafe timing")
        gameContext.forceClearIntervals()
        onMakeDecision()
      } else {
      }
    }
  }
  // Check if target destination is threatened by new bomb
  else if (pathModeManager.isFollowing() && pathModeManager.pathTarget) {
    const target = pathModeManager.pathTarget
    const myBomber = getBomber(gameContext.currentState, gameContext.myUid)

    if (myBomber) {
      // Check what's at the target position
      const map = gameContext.currentState.map
      const targetTile = map[target.y]?.[target.x]

      // Check if target is in blast zone of any bomb
      const unsafeTiles = findUnsafeTiles(
        gameContext.currentState.map,
        gameContext.currentState.bombs,
        gameContext.currentState.bombers,
      )

      const targetKey = `${target.x},${target.y}`
      const isTargetThreatened = unsafeTiles.has(targetKey)

      if (isTargetThreatened) {
        pathModeManager.abortFollow(`Destination "${targetTile}" threatened by bomb`)
        gameContext.forceClearIntervals()
        onMakeDecision()
      } else {
      }
    }
  } else if (
    !manualControlManager.isManualMode() &&
    !pathModeManager.isEscaping() &&
    !pathModeManager.isFollowing() &&
    !gameContext.moveIntervalId &&
    !gameContext.alignIntervalId
  ) {
    onMakeDecision()
  }
}

/**
 * Handle bomb explosion during path execution
 */
function handleBombExplodeDuringPath(
  gameContext,
  pathModeManager,
  manualControlManager,
  onMakeDecision,
) {
  // When bomb explodes, it's already removed from gameState.bombs
  // So we can't check safety based on bombs array
  // Safety should be checked when NEW bombs appear (handleNewBombDuringPath)

  // Only re-evaluate if not in any mode
  if (
    !manualControlManager.isManualMode() &&
    !pathModeManager.isEscaping() &&
    !pathModeManager.isFollowing() &&
    !gameContext.moveIntervalId &&
    !gameContext.alignIntervalId
  ) {
    onMakeDecision()
  } else {
  }
}

/**
 * Handle chest destroyed during path execution
 */
function handleChestDestroyedDuringPath(
  gameContext,
  pathModeManager,
  manualControlManager,
  onMakeDecision,
) {
  // Chest destroyed means a bomb exploded (already removed from bombs array)
  // Safety should be checked when NEW bombs appear, not when they explode

  if (pathModeManager.isEscaping()) {
  } else if (
    !manualControlManager.isManualMode() &&
    !pathModeManager.isFollowing() &&
    !gameContext.moveIntervalId &&
    !gameContext.alignIntervalId
  ) {
    onMakeDecision()
  } else {
  }
}
