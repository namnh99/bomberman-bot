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
    console.log("✅ Connected:", socket.id)
    socket.emit("join", {})
    gameContext.myUid = socket.id
    onSetupManualControl()
  })

  // User state update handler
  socket.on("user", (state) => {
    gameContext.currentState = state
    // Only make decision if not in manual mode AND not currently escaping
    if (
      !manualControlManager.isManualMode() &&
      !pathModeManager.isEscaping() &&
      !gameContext.moveIntervalId &&
      !gameContext.alignIntervalId
    ) {
      onMakeDecision()
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
    console.log(`\n💣 NEW BOMB DEBUG:`)
    console.log(`   ID: ${bomb.id}`)
    console.log(
      `   Position: [${Math.floor(bomb.x / GRID_SIZE)}, ${Math.floor(bomb.y / GRID_SIZE)}]`,
    )
    console.log(`   Owner UID: ${bomb.uid}`)
    console.log(`   Created At (server): ${bomb.createdAt}`)
    console.log(`   Life Time (server): ${bomb.lifeTime}`)
    console.log(`   Client Time (now): ${now}`)
    console.log(`   Time Diff: ${now - bomb.createdAt}ms`)
    console.log(`   Will explode in: ${bomb.lifeTime - (now - bomb.createdAt)}ms`)
    console.log(`   Full bomb object:`, JSON.stringify(bomb, null, 2))

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
    updateMapAfterItemCollect(gameContext.currentState, itemY, itemX)

    const bomber = getBomber(gameContext.currentState, data.bomber?.uid)
    if (bomber && bomber.uid === gameContext.myUid) {
      updateBomberAttributes(gameContext.currentState, bomber.uid, data)
      onMakeDecision()
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
    console.log(`\n🚨 NEW BOMB during escape! Checking if escape path is still safe...`)

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

      console.log(
        `   Current: [${playerGridPos.x}, ${playerGridPos.y}] ${currentUnsafe ? "❌ UNSAFE" : "✅ safe"}`,
      )
      console.log(
        `   Destination: [${finalX}, ${finalY}] ${destinationUnsafe ? "❌ UNSAFE" : "✅ safe"}`,
      )
      console.log(`   Path remaining: ${escapePath.join(" → ")}`)

      if (destinationUnsafe) {
        console.log(`   ⚠️  Escape DESTINATION is unsafe!`)
        console.log(`   🔄 ABORT ESCAPE - Finding new escape route!`)
        // Cancel current escape
        pathModeManager.abortEscape("Destination unsafe")
        gameContext.forceClearIntervals()
        // Immediately find new escape route
        onMakeDecision()
      } else {
        console.log(`   ✅ Escape destination is safe, continuing escape...`)
      }
    }
  }
  // Check follow path (lower priority - abort if ANY tile becomes unsafe)
  else if (pathModeManager.isFollowing() && pathModeManager.getRemainingFollowSteps() > 0) {
    console.log(`\n🚨 NEW BOMB during follow path! Aborting and re-evaluating...`)
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
      console.log("🔔 Enemy bomb detected, re-evaluating...")
      onMakeDecision()
    } else {
      console.log("💣 Our bomb placed, waiting for escape sequence to start...")
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
        console.log(`🚨 BOMB EXPLODED - Current position now UNSAFE! Aborting follow path!`)
        pathModeManager.abortFollow("Current position unsafe")
        gameContext.forceClearIntervals()
        onMakeDecision()
        return
      }

      console.log("💥 Bomb exploded, but still safe - continuing follow path")
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
        console.log(`🚨 BOMB EXPLODED - Current position now UNSAFE during escape!`)
        console.log(`   Re-evaluating escape immediately...`)
        pathModeManager.abortEscape("Current position unsafe")
        gameContext.forceClearIntervals()
        onMakeDecision()
        return
      }

      console.log("💥 Bomb exploded during escape, but still safe - continuing")
    }
  } else if (
    !manualControlManager.isManualMode() &&
    !gameContext.moveIntervalId &&
    !gameContext.alignIntervalId
  ) {
    console.log("💥 Bomb exploded, re-evaluating...")
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
        console.log(`🚨 CHEST DESTROYED - Current position now UNSAFE! Aborting follow path!`)
        pathModeManager.abortFollow("Current position unsafe")
        gameContext.forceClearIntervals()
        onMakeDecision()
        return
      }

      console.log("🧱 Chest destroyed, but still safe - continuing follow path")
    }
  } else if (pathModeManager.isEscaping()) {
    console.log("🏃 Escape in progress, ignoring chest destroyed event")
  } else if (
    !manualControlManager.isManualMode() &&
    !gameContext.moveIntervalId &&
    !gameContext.alignIntervalId
  ) {
    console.log("🧱 Chest destroyed, re-evaluating...")
    onMakeDecision()
  }
}
