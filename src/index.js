import "dotenv/config";
import socketManager from "./socket/SocketManager.js";
import { decideNextAction } from "./bot/bomberman_beam_agent.js";
import { STEP_DELAY, STEP_COUNT } from "./constants/index.js";

const socket = socketManager.getSocket();

let currentState = null;
let myUid = null;
let moveIntervalId = null;
let isMoving = false;

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
  if (bomberIndex !== -1) currentState.bombers[bomberIndex] = data;
  if (data.uid === myUid && !isMoving) {
    makeDecision();
  }
});

socket.on("new_bomb", (bomb) => {
  if (!currentState) return;
  currentState.bombs.push(bomb);
  // console.log("💣 New bomb placed:", bomb);
  makeDecision(); // Re-evaluate decision when a new bomb appears
});

socket.on("bomb_explode", (bomb) => {
  if (!currentState) return;
  const bombIndex = currentState.bombs.findIndex((b) => b.id === bomb.id);
  if (bombIndex !== -1) {
    currentState.bombs.splice(bombIndex, 1);
  }
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
  currentState.items.chests = data.chests;
  currentState.items = data.items;

  // makeDecision(); // Re-evaluate decision after map update
});

// ==================== ACTION HELPERS ====================

function move(direction) {
  socket.emit("move", { orient: direction });
}

function placeBomb() {
  console.log("💣 Place bomb");
  socket.emit("place_bomb", {});
}

let i = 0;

const smoothMove = (direction) => {
  if (isMoving) {
    clearInterval(moveIntervalId);
    i = 0;
  }
  isMoving = true;

  moveIntervalId = setInterval(() => {
    if (i < STEP_COUNT) {
      move(direction);
      i++;
    } else {
      clearInterval(moveIntervalId);
      isMoving = false;
      i = 0;
      makeDecision();
    }
  }, STEP_DELAY);
};

// ==================== DECISION MAKER ====================

function makeDecision() {
  if (!currentState || !myUid || isMoving) return;

  const myBomber = currentState.bombers.find((b) => b.uid === myUid);
  if (!myBomber) return;

  const isAligned =
    myBomber.x % STEP_COUNT === 0 && myBomber.y % STEP_COUNT === 0;
  if (!isAligned) {
    let moveLeftoverX = myBomber.x % STEP_COUNT;
    let moveLeftoverY = myBomber.y % STEP_COUNT;
    if (moveLeftoverX !== 0) {
      console.log("Correcting Y alignment:", moveLeftoverY);
      const direction = moveLeftoverX > STEP_COUNT / 2 ? "RIGHT" : "LEFT";
      while (moveLeftoverX !== 0) {
        socket.emit("move", { orient: direction });
        moveLeftoverX -= 1;
      }
    } else if (moveLeftoverY !== 0) {
      console.log("Correcting Y alignment:", moveLeftoverY);
      const direction = moveLeftoverY > STEP_COUNT / 2 ? "DOWN" : "UP";
      while (moveLeftoverY !== 0) {
        socket.emit("move", { orient: direction });
        moveLeftoverY -= 1;
      }
    }
    return;
  }

  try {
    const decision = decideNextAction(currentState, myUid);
    const { action, escapeAction } = decision;

    if (["UP", "DOWN", "LEFT", "RIGHT"].includes(action)) {
      smoothMove(action);
    } else if (action === "BOMB") {
      placeBomb();
      // After placing a bomb, immediately start moving to the safe zone
      if (
        escapeAction &&
        ["UP", "DOWN", "LEFT", "RIGHT"].includes(escapeAction)
      ) {
        // Use a small delay to allow the bomb placement to register before moving
        setTimeout(() => {
          smoothMove(escapeAction);
        }, 20);
      }
    }
  } catch (err) {
    console.error("⚠️ Decision error:", err);
  }
}
