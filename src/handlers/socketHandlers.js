import { GRID_SIZE, ITEMS } from "../utils/constants.js"
import { toGridCoords } from "../utils/gridUtils.js"
import { getBombWithGrid } from "../utils/bombUtils.js"
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

          // Find the bomb in currentState and update its flag when bot moves away
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

  socket.on("user_die_update", (data) => {
    console.log("💀 User died:", data)
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

      // CRITICAL: Check ENTIRE remaining escape path, not just destination
      const escapePath = pathModeManager.escapePath
      let pathHasUnsafeTile = false
      let unsafeTileInfo = null

      for (const step of escapePath) {
        if (unsafeTiles.has(step)) {
          pathHasUnsafeTile = true
          unsafeTileInfo = step
          break
        }
      }

      const currentUnsafe = unsafeTiles.has(`${playerGridPos.x},${playerGridPos.y}`)

      console.log(
        `   Current: [${playerGridPos.x}, ${playerGridPos.y}] ${currentUnsafe ? "❌ UNSAFE" : "✅ safe"}`,
      )
      console.log(`   Path remaining: ${escapePath.join(" → ")}`)

      if (pathHasUnsafeTile) {
        console.log(`   ⚠️  Escape path tile [${unsafeTileInfo}] is now UNSAFE!`)
        console.log(`   🔄 ABORT ESCAPE - Finding new escape route!`)
        // Cancel current escape
        pathModeManager.abortEscape("Path blocked by new bomb")
        gameContext.forceClearIntervals()
        // Immediately find new escape route
        onMakeDecision()
      } else {
        console.log(`   ✅ Entire escape path is safe, continuing escape...`)
      }
    }
  }
  // Check follow path (lower priority)
  else if (pathModeManager.isFollowing() && pathModeManager.getRemainingFollowSteps() > 0) {
    const myBomber = getBomber(gameContext.currentState, gameContext.myUid)
    if (myBomber) {
      console.log(`\n🚨 NEW BOMB during follow path! Checking if path is still safe...`)

      const unsafeTiles = findUnsafeTiles(
        gameContext.currentState.map,
        gameContext.currentState.bombs,
        gameContext.currentState.bombers,
      )

      // CRITICAL: Check ENTIRE remaining follow path
      const followPath = pathModeManager.followPath
      let pathHasUnsafeTile = false
      let unsafeTileInfo = null

      for (const step of followPath) {
        if (unsafeTiles.has(step)) {
          pathHasUnsafeTile = true
          unsafeTileInfo = step
          break
        }
      }

      console.log(`   Path remaining: ${followPath.join(" → ")}`)

      if (pathHasUnsafeTile) {
        console.log(`   ⚠️  Follow path tile [${unsafeTileInfo}] is now UNSAFE!`)
        console.log(`   🔄 Aborting follow and re-evaluating...`)
        pathModeManager.abortFollow("Path blocked by new bomb")
        gameContext.forceClearIntervals()
        onMakeDecision()
      } else {
        console.log(`   ✅ Entire follow path is safe, continuing...`)
      }
    }
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
  // When bomb explodes, it's already removed from gameState.bombs
  // So we can't check safety based on bombs array
  // Safety should be checked when NEW bombs appear (handleNewBombDuringPath)

  // Only re-evaluate if not in any mode
  if (gameContext.waitingForBombPlacement) {
    console.log("💣 Waiting for bomb placement, ignoring bomb exploded event")
  } else if (
    !manualControlManager.isManualMode() &&
    !pathModeManager.isEscaping() &&
    !pathModeManager.isFollowing() &&
    !gameContext.moveIntervalId &&
    !gameContext.alignIntervalId
  ) {
    console.log("💥 Bomb exploded, re-evaluating...")
    onMakeDecision()
  } else {
    console.log("💥 Bomb exploded - path continues (safety checked on new_bomb events)")
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
    console.log("🏃 Escape in progress, ignoring chest destroyed event")
  } else if (gameContext.waitingForBombPlacement) {
    console.log("💣 Waiting for bomb placement, ignoring chest destroyed event")
  } else if (
    !manualControlManager.isManualMode() &&
    !pathModeManager.isFollowing() &&
    !gameContext.moveIntervalId &&
    !gameContext.alignIntervalId
  ) {
    console.log("🧱 Chest destroyed, re-evaluating...")
    onMakeDecision()
  } else {
    console.log("🧱 Chest destroyed - path continues (safety checked on new_bomb events)")
  }
}
