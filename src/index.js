import "dotenv/config";
import socketManager from "./socket/SocketManager.js";
import { decideNextAction } from "./bot/bomberman_beam_agent.js";
import {
  STEP_DELAY,
  STEP_COUNT,
  ALIGNMENT_THRESHOLD,
} from "./constants/index.js";

const socket = socketManager.getSocket();

let currentState = null;
let myUid = null;
let moveIntervalId = null;
let alignIntervalId = null;
let escapeMode = false; // Track if bot is executing escape sequence
let escapePath = []; // Store the full escape path

// ==================== SOCKET EVENTS ====================

socket.on("connect", () => {
  console.log("✅ Connected:", socket.id);
  socket.emit("join", {});
  myUid = socket.id;
});

socket.on("user", (state) => {
  currentState = state;
  makeDecision();
});

socket.on("player_move", (data) => {
  if (!currentState) return;
  const bomberIndex = currentState.bombers.findIndex((b) => b.uid === data.uid);
  if (bomberIndex !== -1) {
    currentState.bombers[bomberIndex] = data;
    // Log position updates for debugging
    if (data.uid === myUid) {
      // console.log(
      //   `🔄 Position updated: [${Math.floor(data.x / STEP_COUNT)}, ${Math.floor(
      //     data.y / STEP_COUNT
      //   )}] | Pixel: [${data.x}, ${data.y}]`
      // );
    }
  }
});

socket.on("new_bomb", (bomb) => {
  if (!currentState) return;
  console.log(
    `💣 New bomb placed at [${Math.floor(bomb.x / STEP_COUNT)}, ${Math.floor(
      bomb.y / STEP_COUNT
    )}] | id: ${bomb.id} | uid: ${bomb.uid}`
  );
  currentState.bombs.push(bomb);
  console.log(`   � Total bombs in state: ${currentState.bombs.length}`);
  makeDecision(); // Re-evaluate decision when a new bomb appears
});

socket.on("bomb_explode", (bomb) => {
  if (!currentState) return;
  console.log(
    `💥 Bomb exploded at [${Math.floor(bomb.x / STEP_COUNT)}, ${Math.floor(
      bomb.y / STEP_COUNT
    )}] | id: ${bomb.id}`
  );
  const bombIndex = currentState.bombs.findIndex((b) => b.id === bomb.id);
  if (bombIndex !== -1) {
    console.log(
      `   ✅ Removing exploded bomb from state (index: ${bombIndex})`
    );
    currentState.bombs.splice(bombIndex, 1);
  } else {
    console.log(`   ⚠️ Exploded bomb not found in current state!`);
  }
  console.log(`   📊 Remaining bombs in state: ${currentState.bombs.length}`);
  makeDecision(); // Re-evaluate decision after an explosion
});

socket.on("chest_destroyed", (chest) => {
  if (!currentState) return;
  const chestX = Math.floor(chest.x / STEP_COUNT);
  const chestY = Math.floor(chest.y / STEP_COUNT);
  let item = null;

  if (chest.item?.type) {
    switch (chest.item.type) {
      case "SPEED":
        item = "S";
        break;
      case "EXPLOSION_RANGE":
        item = "R";
        break;
      case "BOMB_COUNT":
        item = "B";
        break;
    }
  }

  currentState.map[chestY][chestX] = item;
  makeDecision(); // Re-evaluate decision after a chest is destroyed
});

socket.on("item_collected", (data) => {
  if (!currentState) return;
  const itemX = Math.floor(data.item.x / STEP_COUNT);
  const itemY = Math.floor(data.item.y / STEP_COUNT);
  currentState.map[itemY][itemX] = null;
  // TODO: Could also update bomber's attributes if needed
  makeDecision(); // Re-evaluate decision after an item is collected
});

socket.on("map_update", (data) => {
  if (!currentState) return;
  currentState.chests = data.chests;
  currentState.items = data.items;
  // makeDecision(); // Re-evaluate decision after map update
});

// ==================== ACTION HELPERS ====================

function move(direction) {
  socket.emit("move", { orient: direction });
}

function placeBomb() {
  // console.log("💣 Place bomb");
  socket.emit("place_bomb", {});
}

let i = 0;

const smoothMove = (direction, speed = 1, isEscapeMove = false) => {
  if (moveIntervalId) {
    console.log(`⚠️  Canceling previous move to start new move: ${direction}`);
    clearInterval(moveIntervalId);
    moveIntervalId = null;
    i = 0;
  }
  if (alignIntervalId) {
    console.log(`⚠️  Canceling alignment to start move: ${direction}`);
    clearInterval(alignIntervalId);
    alignIntervalId = null;
  }

  // Calculate steps based on speed: each emit moves (speed) pixels
  const stepsNeeded = Math.ceil(STEP_COUNT / speed);
  const moveLabel = isEscapeMove ? "🏃 ESCAPE move" : "🏃 Starting smooth move";
  console.log(
    `${moveLabel}: ${direction} (speed: ${speed}, steps: ${stepsNeeded})`
  );

  moveIntervalId = setInterval(() => {
    if (i < stepsNeeded) {
      move(direction);
      i++;
    } else {
      clearInterval(moveIntervalId);
      moveIntervalId = null;
      i = 0;
      console.log(`✅ Move complete: ${direction}`);

      // If in escape mode, continue with next step or exit escape mode
      if (escapeMode && escapePath.length > 0) {
        const nextMove = escapePath.shift();
        console.log(
          `🏃 Continuing escape: ${nextMove} (${escapePath.length} steps remaining)`
        );
        smoothMove(nextMove, speed, true);
      } else {
        // Escape complete or normal move done
        if (escapeMode) {
          console.log(`✅ Escape sequence completed!`);
          escapeMode = false;
          escapePath = [];
          console.log(
            `   ⏸️ Waiting briefly before next decision (bombs may still be active)...`
          );
          // Wait a bit before making next decision to avoid re-entering danger zones
          // The bomb that caused the escape might still be active
          setTimeout(() => {
            makeDecision();
          }, 500); // 500ms delay to let bombs explode
          return; // Don't call makeDecision immediately
        }
        makeDecision();
      }
    }
  }, STEP_DELAY);
};

// ==================== DECISION MAKER ====================

function makeDecision() {
  if (!currentState || !myUid) return;

  // If in escape mode, don't interrupt - let escape sequence complete
  if (escapeMode && (moveIntervalId || alignIntervalId)) {
    console.log(
      `🏃 Escape in progress... (${escapePath.length} steps remaining)`
    );
    return;
  }

  // Cancel any ongoing movement or alignment (only if NOT in escape mode)
  if (moveIntervalId || alignIntervalId) {
    console.log("⏸️  Canceling movement to make new decision");
    clearInterval(moveIntervalId);
    moveIntervalId = null;
    clearInterval(alignIntervalId);
    alignIntervalId = null;
  }

  const myBomber = currentState.bombers.find((b) => b.uid === myUid);
  if (!myBomber) return;

  console.log(
    `\n📍 Position: [${Math.floor(myBomber.x / STEP_COUNT)}, ${Math.floor(
      myBomber.y / STEP_COUNT
    )}] | Pixel: [${myBomber.x}, ${myBomber.y}] | Orient: ${myBomber.orient}`
  );

  try {
    const decision = decideNextAction(currentState, myUid);
    const { action, escapeAction, isEscape, fullPath } = decision;

    // If this is an escape decision with a full path, enter escape mode
    if (isEscape && fullPath && fullPath.length > 1) {
      console.log(`🚨 Entering ESCAPE MODE - ${fullPath.length} step sequence`);
      escapeMode = true;
      escapePath = [...fullPath]; // Copy the full path
      const firstMove = escapePath.shift(); // Remove first move from queue
      smoothMove(firstMove, myBomber.speed, true);
      return;
    }

    if (["UP", "DOWN", "LEFT", "RIGHT"].includes(action)) {
      // Align to grid if not already aligned before moving
      let moveOver = 0;
      let alignDirection = null;

      if (action === "UP" || action === "DOWN") {
        moveOver = myBomber.x % STEP_COUNT;
        if (moveOver !== 0) {
          // Choose shortest path to align
          if (moveOver > STEP_COUNT / 2) {
            alignDirection = "RIGHT";
            moveOver = STEP_COUNT - moveOver;
          } else {
            alignDirection = "LEFT";
          }
        }
      } else if (action === "LEFT" || action === "RIGHT") {
        moveOver = myBomber.y % STEP_COUNT;
        if (moveOver !== 0) {
          // Choose shortest path to align
          if (moveOver > STEP_COUNT / 2) {
            alignDirection = "DOWN";
            moveOver = STEP_COUNT - moveOver;
          } else {
            alignDirection = "UP";
          }
        }
      }

      // Execute alignment before main move
      // Note: Always align when moving perpendicular, even if misalignment is small
      // The server may reject movement if not properly aligned
      if (moveOver > 0 && alignDirection) {
        // Calculate alignment steps based on speed
        const alignSteps = Math.ceil(moveOver / myBomber.speed);
        let stepsLeft = alignSteps;
        console.log(
          `🔧 Aligning ${alignDirection} (${moveOver}px in ${alignSteps} steps, speed: ${myBomber.speed}) before moving ${action}`
        );

        alignIntervalId = setInterval(() => {
          if (stepsLeft > 0) {
            socket.emit("move", { orient: alignDirection });
            stepsLeft--;
          } else {
            clearInterval(alignIntervalId);
            alignIntervalId = null;
            console.log(`✅ Alignment complete, starting move: ${action}`);
            // Start main move after alignment
            smoothMove(action, myBomber.speed);
          }
        }, STEP_DELAY);
      } else {
        // Already perfectly aligned, move directly
        console.log(`✅ Already aligned, moving: ${action}`);
        smoothMove(action, myBomber.speed);
      }
    } else if (action === "BOMB") {
      console.log(`💣 Placing bomb`);
      placeBomb();
      // After placing a bomb, immediately start moving to the safe zone
      if (
        escapeAction &&
        ["UP", "DOWN", "LEFT", "RIGHT"].includes(escapeAction)
      ) {
        console.log(`🏃 Escaping: ${escapeAction}`);
        // Use a small delay to allow the bomb placement to register before moving
        setTimeout(() => {
          smoothMove(escapeAction, myBomber.speed);
        }, STEP_DELAY);
      }
    } else if (action === "STAY") {
      console.log(`⏸️  Staying put`);
    }
  } catch (err) {
    console.error("⚠️ Decision error:", err);
  }
}
