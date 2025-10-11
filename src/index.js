import socketManager from "./socket/SocketManager.js";
import { decideNextAction } from "./bot/bomberman_beam_agent.js";

const socket = socketManager.getSocket();

let currentState = null;
let myUid = null;
let direction = null;
let moveIntervalId = null; // Store interval ID for interruption

const BEAM_WIDTH = 8;
const DEPTH = 6;

// ==================== SOCKET EVENTS ====================

socket.on("connect", () => {
  console.log("✅ Connected:", socket.id);
  socket.emit("join", {});
  myUid = socket.id;
});

socket.on("user", (state) => {
  console.log("👤 Received user state");
  console.log(state);
  currentState = state;
  makeDecision();
});

const max = 40;
let i = 0;
let isMoving = false;

const smoothMove = (direction) => {
  isMoving = true;

  const me = currentState.bombers.find((b) => b.uid === myUid);
  if (!me) return;

  moveIntervalId = setInterval(() => {
    if (i <= max + 1) {
      move(direction);
      i++;
    } else {
      clearInterval(moveIntervalId);
      isMoving = false;
      makeDecision();
      i = 0;
    }
  }, 20);
};

socket.on("player_move", (data) => {
  if (!currentState) return;

  const bomberIndex = currentState.bombers.findIndex((b) => b.uid === data.uid);
  if (bomberIndex !== -1) currentState.bombers[bomberIndex] = data;

  if (data.uid === myUid && !isMoving) {
    // makeDecision();
  }
});

socket.on("new_bomb", (bomb) => {
  if (!currentState) return;
  // console.log("🔥 New bomb on map:", bomb);
  currentState.bombs.push(bomb);
  makeDecision();
});

socket.on("bomb_explode", (bomb) => {
  if (!currentState) return;
  // console.log("💥 Bomb exploded:", bomb);
  const bombIndex = currentState.bombs.findIndex((b) => b.id === bomb.id);
  if (bombIndex !== -1) currentState.bombs[bombIndex] = bomb;
  makeDecision();
});

socket.on("map_update", (data) => {
  if (!currentState) return;
  // console.log("💥 Bomb exploded:", data);
  currentState = { ...currentState, ...data };
  makeDecision();
});

// ==================== ACTION HELPERS ====================
function move(direction) {
  socket.emit("move", { orient: direction });
  const me = currentState.bombers.find((b) => b.uid === myUid);
  if (me) me.orient = direction; // update orient
}

function placeBomb() {
  console.log("💣 Place bomb");
  socket.emit("place_bomb", {});
}

// ==================== DECISION MAKER ====================
function makeDecision() {
  if (!currentState || !myUid || isMoving) return;

  try {
    const decision = decideNextAction(currentState, myUid);
    const { action } = decision;

    if (["UP", "DOWN", "LEFT", "RIGHT"].includes(action)) {
      smoothMove(action);
    } else if (action === "BOMB") {
      placeBomb();
    }
  } catch (err) {
    console.error("⚠️ Decision error:", err);
  }
}
