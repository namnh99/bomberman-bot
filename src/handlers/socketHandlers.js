import { toGridCoords } from "../utils/gridUtils.js"
import { GRID_SIZE, ITEMS } from "../utils/constants.js"
import { findUnsafeTiles } from "../bot/agent.js"
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
    onSetupManualControl()
  })

  // Game start handler - wait for this before making any decisions
  socket.on("start", (data) => {

    // Make initial decision when game starts
    if (gameContext.currentState && !manualControlManager.isManualMode()) {
      onMakeDecision()
    }
  })

  // User state update handler - no longer triggers decision (wait for 'start' event)
  socket.on("user", (state) => {
    gameContext.currentState = state
    // Don't make decisions on 'user' event anymore
    // Wait for 'start' event or other triggers
  })

  // User death handler - remove killed player from state
  socket.on("user_die_update", (data) => {
    if (!gameContext.currentState) return


    // Remove the killed player from bombers list
    if (data.killed?.uid && gameContext.currentState.bombers) {
      gameContext.currentState.bombers = gameContext.currentState.bombers.filter(
        (bomber) => bomber.uid !== data.killed.uid,
      )
    }

    // Update all bombers with the new list from event
    if (data.bombers && Array.isArray(data.bombers)) {
      gameContext.currentState.bombers = data.bombers
    }

    // Check if WE died
    if (data.killed?.uid === gameContext.myUid) {
      gameContext.forceClearIntervals()
      pathModeManager.abortEscape("We died")
      pathModeManager.abortFollow("We died")
    } else {
      // Enemy died - re-evaluate strategy if not in manual mode
      if (
        !manualControlManager.isManualMode() &&
        !pathModeManager.isEscaping() &&
        !gameContext.moveIntervalId &&
        !gameContext.alignIntervalId
      ) {
        onMakeDecision()
      }
    }
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

          // Find the bomb in currentState and update its flag
          const bomb = gameContext.currentState.bombs.find((b) => b.id === bombId)
          if (bomb && bomb.walkable) bomb.walkable = false
        }
      })
    }

    // Update bomber's position in state
    updateBomberPosition(gameContext.currentState, data.uid, data.x, data.y)
  })

  // New bomb handler
  socket.on("new_bomb", (bomb) => {
    if (!gameContext.currentState) return

    // DEBUG: Log bomb object details to understand server data
    const now = Date.now()

    const myBomber = getBomber(gameContext.currentState, gameContext.myUid)
    const { x: bombX, y: bombY } = toGridCoords(bomb.x, bomb.y)

    // Check if Bot is standing on the bomb tile when it's placed
    // ONLY set walkable if this is OUR bomb (we just placed it)
    let botOnTheBomb = false
    if (myBomber) {
      botOnTheBomb = isBomberOnBombTile(myBomber, bombX, bombY)
    }
    bomb.walkable = botOnTheBomb

    if (!bombTracker.has(bomb.id) && botOnTheBomb) {
      bombTracker.add(bomb.id, bombX, bombY, bomb.uid)
    }
    addBomb(gameContext.currentState, bomb)

    // CRITICAL: Check if new bomb affects our paths
    handleNewBombDuringPath(
      bomb,
      gameContext,
      pathModeManager,
      manualControlManager,
      onMakeDecision,
    )
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
    }
  })

  // Map update handler
  socket.on("map_update", (data) => {
    if (!gameContext.currentState) return
    gameContext.currentState.chests = data.chests
    gameContext.currentState.items = data.items
  })
}

/**
 * Handle new bomb during path execution
 */
function handleNewBombDuringPath(
  bomb,
  gameContext,
  pathModeManager,
  manualControlManager,
  onMakeDecision,
) {
  // Check escape path first (highest priority)
  if (pathModeManager.isEscaping() && pathModeManager.getRemainingEscapeSteps() > 0) {

    const myBomber = getBomber(gameContext.currentState, gameContext.myUid)
    if (myBomber) {
      const playerGridPos = toGridCoords(myBomber.x, myBomber.y)

      // Check if the new bomb threatens our escape path
      const unsafeTiles = findUnsafeTiles(
        gameContext.currentState.map,
        gameContext.currentState.bombs,
        gameContext.currentState.bombers,
      )

      // Calculate DESTINATION from CURRENT position (not start position)
      let finalX = playerGridPos.x
      let finalY = playerGridPos.y

      const escapePath = pathModeManager.escapePath
      for (const step of escapePath) {
        if (step === "UP") finalY--
        else if (step === "DOWN") finalY++
        else if (step === "LEFT") finalX--
        else if (step === "RIGHT") finalX++
      }

      const destinationUnsafe = unsafeTiles.has(`${finalX},${finalY}`)
      const currentUnsafe = unsafeTiles.has(`${playerGridPos.x},${playerGridPos.y}`)


      if (destinationUnsafe) {
        // Cancel current escape
        pathModeManager.abortEscape("Destination unsafe")
        gameContext.forceClearIntervals()
        // Immediately find new escape route
        onMakeDecision()
      } else {
      }
    }
  }
  // Check follow path (lower priority - abort if ANY tile becomes unsafe)
  else if (pathModeManager.isFollowing() && pathModeManager.getRemainingFollowSteps() > 0) {
    pathModeManager.abortFollow("New bomb detected")
    gameContext.forceClearIntervals()
    onMakeDecision()
  } else if (
    !manualControlManager.isManualMode() &&
    !pathModeManager.isEscaping() &&
    !pathModeManager.isFollowing() &&
    !gameContext.moveIntervalId &&
    !gameContext.alignIntervalId
  ) {
    // Only re-evaluate if this is NOT our own bomb (we already have an escape plan)
    const isOurBomb = bomb.uid === gameContext.myUid
    if (!isOurBomb) {
      onMakeDecision()
    } else {
    }
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
  // CRITICAL: Check safety even during follow mode
  if (pathModeManager.isFollowing() && pathModeManager.getRemainingFollowSteps() > 0) {
    const myBomber = getBomber(gameContext.currentState, gameContext.myUid)
    if (myBomber) {
      const playerGridPos = toGridCoords(myBomber.x, myBomber.y)
      const unsafeTiles = findUnsafeTiles(
        gameContext.currentState.map,
        gameContext.currentState.bombs,
        gameContext.currentState.bombers,
      )

      // Check if current position is now unsafe after bomb explosion
      if (unsafeTiles.has(`${playerGridPos.x},${playerGridPos.y}`)) {
        pathModeManager.abortFollow("Current position unsafe")
        gameContext.forceClearIntervals()
        onMakeDecision()
        return
      }

    }
  } else if (pathModeManager.isEscaping() && pathModeManager.getRemainingEscapeSteps() > 0) {
    // CRITICAL: Even during escape, check if we're still safe
    const myBomber = getBomber(gameContext.currentState, gameContext.myUid)
    if (myBomber) {
      const playerGridPos = toGridCoords(myBomber.x, myBomber.y)
      const unsafeTiles = findUnsafeTiles(
        gameContext.currentState.map,
        gameContext.currentState.bombs,
        gameContext.currentState.bombers,
      )

      // Check if current position became unsafe after bomb explosion
      if (unsafeTiles.has(`${playerGridPos.x},${playerGridPos.y}`)) {
        pathModeManager.abortEscape("Current position unsafe")
        gameContext.forceClearIntervals()
        onMakeDecision()
        return
      }

    }
  } else if (
    !manualControlManager.isManualMode() &&
    !gameContext.moveIntervalId &&
    !gameContext.alignIntervalId
  ) {
    onMakeDecision()
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
  // CRITICAL: Check safety even during follow mode (chest destroyed means bomb exploded nearby)
  if (pathModeManager.isFollowing() && pathModeManager.getRemainingFollowSteps() > 0) {
    const myBomber = getBomber(gameContext.currentState, gameContext.myUid)
    if (myBomber) {
      const playerGridPos = toGridCoords(myBomber.x, myBomber.y)
      const unsafeTiles = findUnsafeTiles(
        gameContext.currentState.map,
        gameContext.currentState.bombs,
        gameContext.currentState.bombers,
      )

      // Check if current position is now unsafe after chest destruction
      if (unsafeTiles.has(`${playerGridPos.x},${playerGridPos.y}`)) {
        pathModeManager.abortFollow("Current position unsafe")
        gameContext.forceClearIntervals()
        onMakeDecision()
        return
      }

    }
  } else if (pathModeManager.isEscaping()) {
  } else if (
    !manualControlManager.isManualMode() &&
    !gameContext.moveIntervalId &&
    !gameContext.alignIntervalId
  ) {
    onMakeDecision()
  }
}
