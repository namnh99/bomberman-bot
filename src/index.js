import socketManager from "./socket/SocketManager.js";
import { decideNextAction } from "./bot/bomberman_beam_agent.js";

const socket = socketManager.getSocket();

let currentState = null;
let myUid = null;
let direction = null;

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

  const intervalId = setInterval(() => {
    if (i < max) {
      move(direction);
      i++;
    } else {
      clearInterval(intervalId);
      isMoving = false;
      i = 0;
    }
  }, 20);
};

socket.on("player_move", (data) => {
  if (!currentState || isMoving) return;

  const bomberIndex = currentState.bombers.findIndex((b) => b.uid === data.uid);
  if (bomberIndex !== -1) {
    currentState.bombers[bomberIndex] = data;
  }

  if (data.uid === myUid) makeDecision(direction);
});

// ==================== ACTION HELPERS ====================
function move(direction) {
  socket.emit("move", { orient: direction });
  const me = currentState.bombers.find((b) => b.uid === myUid);
  if (me) me.orient = direction; // cập nhật orient
}

function placeBomb() {
  console.log("💣 Place bomb");
  socket.emit("place_bomb", {});
}

// ==================== DECISION MAKER ====================
function makeDecision() {
  if (!currentState || !myUid || isMoving) return;

  try {
    const { action } = decideNextAction(currentState, myUid, {
      beamWidth: BEAM_WIDTH,
      depth: DEPTH,
    });

    console.log("trigger", action);

    if (["UP", "DOWN", "LEFT", "RIGHT"].includes(action)) {
      smoothMove(action);
    } else if (action === "BOMB") {
      placeBomb();
    }
  } catch (err) {
    console.error("⚠️ Decision error:", err);
  }
}
