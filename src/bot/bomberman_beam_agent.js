// bomberman_beam_agent_move_smooth.js
// Beam Search bot chỉ di chuyển, smooth movement, né tường và dead-end

const CELL = 40;
const ACTIONS = ["UP", "DOWN", "LEFT", "RIGHT", "STAY"];
const DIRS = {
  UP: { dx: 0, dy: -1 },
  DOWN: { dx: 0, dy: +1 },
  LEFT: { dx: -1, dy: 0 },
  RIGHT: { dx: 1, dy: 0 },
  STAY: { dx: 0, dy: 0 },
};

function inBounds(map, gx, gy) {
  return gy >= 0 && gy < map.length && gx >= 0 && gx < map[0].length;
}

function isFree(map, gx, gy) {
  if (!inBounds(map, gx, gy)) return false;
  const v = map[gy][gx];
  return v === null || v === "S" || v === "R" || v === "B";
}

function freeNeighbors(map, gx, gy) {
  let count = 0;
  for (const dir of Object.values(DIRS)) {
    const nx = gx + dir.dx,
      ny = gy + dir.dy;
    if (isFree(map, nx, ny)) count++;
  }
  return count;
}

function cloneState(s) {
  return {
    gx: s.gx,
    gy: s.gy,
    alive: s.alive,
    uid: s.uid,
    mapRef: s.mapRef,
    actionHistory: [...s.actionHistory],
    lastDir: s.lastDir || null,
    hitWall: s.hitWall || false,
  };
}

function applyActionOnState(state, action, map) {
  if (!state.alive) return false;
  const mv = DIRS[action];
  const ngx = state.gx + mv.dx;
  const ngy = state.gy + mv.dy;
  if (inBounds(map, ngx, ngy) && isFree(map, ngx, ngy)) {
    state.gx = ngx;
    state.gy = ngy;
    state.lastDir = action;
    state.hitWall = false;
    return true;
  } else {
    state.lastDir = "STAY";
    state.hitWall = true;
    return false;
  }
}

// evaluate state với discount để step gần quan trọng hơn
function evaluateState(state, map, items, opponents, tick) {
  if (!state.alive) return -1000;
  let score = 0;

  // penalty hit wall
  if (state.hitWall) score -= tick === 1 ? 100 : 10; // step đầu nặng hơn

  // reward free neighbors
  const freeNbr = freeNeighbors(map, state.gx, state.gy);
  score += freeNbr * 10;

  // smooth movement
  const currAction = state.actionHistory[state.actionHistory.length - 1];
  const prevAction =
    state.actionHistory.length > 1
      ? state.actionHistory[state.actionHistory.length - 2]
      : null;

  if (currAction && currAction !== "STAY") {
    score += 8;
    if (currAction === prevAction) score += 2;
  } else if (currAction === "STAY") score -= 5;

  // small tick reward
  score += tick * 0.05;

  return score;
}

function generateSuccessors(state, map) {
  const out = [];
  for (const a of ACTIONS) {
    const ns = cloneState(state);
    ns.actionHistory.push(a);
    applyActionOnState(ns, a, map);
    out.push({ action: a, state: ns });
  }
  return out;
}

function beamSearch(gameState, myUid, opts = {}) {
  const beamWidth = opts.beamWidth || 6;
  const depth = opts.depth || 3;
  const map = gameState.map;

  const myBomber = gameState.bombers.find((b) => b.uid === myUid);
  if (!myBomber || !myBomber.isAlive) return { action: "STAY", plan: [] };

  const start = {
    gx: Math.floor(myBomber.x / CELL),
    gy: Math.floor(myBomber.y / CELL),
    alive: true,
    uid: myUid,
    mapRef: map,
    actionHistory: [],
    lastDir: null,
    hitWall: false,
  };

  let frontier = [{ state: start, score: 0 }];

  for (let t = 1; t <= depth; t++) {
    const candidates = [];
    for (const node of frontier) {
      const next = generateSuccessors(node.state, map);
      for (const s of next) {
        let sc = evaluateState(s.state, map, [], [], t);

        // encourage move (not STAY) at first step
        if (
          t === 1 &&
          s.state.actionHistory[0] !== "STAY" &&
          !s.state.hitWall
        ) {
          sc += opts.moveBias || 10;
        }

        candidates.push({ state: s.state, score: sc });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    frontier = candidates.slice(0, beamWidth);
    if (frontier.length === 0) break;
  }

  frontier.sort((a, b) => b.score - a.score);
  let best = frontier[0] || { state: start };

  const firstAction = best.state.actionHistory[0] || "STAY";
  return { action: firstAction, plan: best.state.actionHistory || [] };
}

export function decideNextAction(gameState, myUid, options = {}) {
  try {
    if (!gameState || !Array.isArray(gameState.bombers))
      return { action: "STAY", plan: [] };
    if (!myUid) return { action: "STAY", plan: [] };
    return beamSearch(gameState, myUid, options);
  } catch (err) {
    console.error("beamSearch error:", err);
    return { action: "STAY", plan: [] };
  }
}
