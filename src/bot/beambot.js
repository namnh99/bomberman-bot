// bomberman_beambot.js
// Run: node bomberman_beambot.js
// Simple Bomberman-like simulator + Beam Search agent (simplified)

const { performance } = require("perf_hooks");

/* ===========================
   Config / Utilities
   =========================== */
const DIRS = {
  UP: [0, -1],
  DOWN: [0, 1],
  LEFT: [-1, 0],
  RIGHT: [1, 0],
  STAY: [0, 0],
};
const ACTIONS = [
  { type: "MOVE", dir: "UP" },
  { type: "MOVE", dir: "DOWN" },
  { type: "MOVE", dir: "LEFT" },
  { type: "MOVE", dir: "RIGHT" },
  { type: "BOMB" },
  { type: "STAY" },
];

function clone(obj) {
  return JSON.parse(JSON.stringify(obj)); // simple deep clone
}

/* ===========================
   Game Model
   =========================== */

// Map cell types: '.' empty, '#' wall (indestructible), 'X' crate (breakable), 'P' powerup
class GameState {
  constructor(width, height, mapCells, players = [], bombs = [], tick = 0) {
    this.width = width;
    this.height = height;
    this.map = mapCells; // 2D array chars
    this.players = players; // array of {id, x, y, alive, bombsCount, bombRange}
    this.bombs = bombs; // array of {x, y, ownerId, timer, range}
    this.tick = tick;
    this.powerups = []; // array of {x,y,type} - type: 'R' range, 'B' extra-bomb
  }

  // helper: check inside map
  inBounds(x, y) {
    return x >= 0 && x < this.width && y >= 0 && y < this.height;
  }

  getCell(x, y) {
    if (!this.inBounds(x, y)) return "#";
    return this.map[y][x];
  }

  setCell(x, y, v) {
    if (!this.inBounds(x, y)) return;
    this.map[y][x] = v;
  }
}

/* ===========================
   Simulator: apply action + tick
   (very simplified rules)
   =========================== */

function applyAction(state, playerId, action) {
  const p = state.players.find((pl) => pl.id === playerId);
  if (!p || !p.alive) return;
  if (action.type === "MOVE") {
    const d = DIRS[action.dir];
    const nx = p.x + d[0],
      ny = p.y + d[1];
    if (!state.inBounds(nx, ny)) return;
    const cell = state.getCell(nx, ny);
    // cannot walk into walls or crates or bombs (simplified)
    const bombAt = state.bombs.some((b) => b.x === nx && b.y === ny);
    if (cell === "#" || cell === "X" || bombAt) return;
    p.x = nx;
    p.y = ny;
    // pick up powerup if present
    const idx = state.powerups.findIndex((pp) => pp.x === nx && pp.y === ny);
    if (idx >= 0) {
      const pu = state.powerups.splice(idx, 1)[0];
      if (pu.type === "R") p.bombRange += 1;
      if (pu.type === "B") p.bombsCount += 1;
    }
  } else if (action.type === "BOMB") {
    // place bomb if player has some bombs left
    if (p.bombsCount > 0) {
      // don't place bomb on existing bomb
      if (!state.bombs.some((b) => b.x === p.x && b.y === p.y)) {
        state.bombs.push({
          x: p.x,
          y: p.y,
          ownerId: p.id,
          timer: 8,
          range: p.bombRange,
        });
        p.bombsCount -= 1;
      }
    }
  } else if (action.type === "STAY") {
    // nothing
  }
}

function updateBombsAndExplosions(state) {
  // reduce timers
  for (const b of state.bombs) b.timer -= 1;

  // collect bombs that explode now (timer <= 0)
  const explodeList = state.bombs.filter((b) => b.timer <= 0);
  if (explodeList.length === 0) return;

  // mark explosion tiles
  const explosionTiles = new Set();
  function mark(x, y) {
    if (state.inBounds(x, y)) explosionTiles.add(`${x},${y}`);
  }

  for (const b of explodeList) {
    mark(b.x, b.y);
    // spread in 4 directions until hit wall (#) or up to range, crate (X) stops spread but is destroyed
    for (const dir of Object.values(DIRS).slice(0, 4)) {
      for (let r = 1; r <= b.range; r++) {
        const nx = b.x + dir[0] * r,
          ny = b.y + dir[1] * r;
        if (!state.inBounds(nx, ny)) break;
        const cell = state.getCell(nx, ny);
        mark(nx, ny);
        if (cell === "#") break; // indestructible stop (but shouldn't mark beyond)
        if (cell === "X") {
          // crate destroyed, may spawn powerup
          // destroy it
          state.setCell(nx, ny, ".");
          // spawn a powerup sometimes (simplified deterministic: every crate -> powerup type by parity)
          const puType =
            (nx + ny) % 3 === 0 ? "R" : (nx + ny) % 3 === 1 ? "B" : null;
          if (puType) state.powerups.push({ x: nx, y: ny, type: puType });
          break; // crate stops explosion propagation
        }
      }
    }
  }

  // eliminate bombs that exploded and return bombsCount to owners for bombs that exploded (owner can place again)
  for (const b of explodeList) {
    const owner = state.players.find((pl) => pl.id === b.ownerId);
    if (owner) owner.bombsCount += 1;
  }
  state.bombs = state.bombs.filter((b) => b.timer > 0);

  // apply damage to players in explosionTiles
  for (const p of state.players) {
    if (!p.alive) continue;
    if (explosionTiles.has(`${p.x},${p.y}`)) {
      p.alive = false;
    }
  }
}

function tickState(state, actionsByPlayer) {
  // actionsByPlayer: map playerId -> action
  // apply moves/bombs (simultaneously)
  for (const pl of state.players) {
    const act = actionsByPlayer[pl.id] || { type: "STAY" };
    applyAction(state, pl.id, act);
  }
  // update bombs and explosions
  updateBombsAndExplosions(state);
  state.tick += 1;
}

/* ===========================
   Helper functions for eval
   =========================== */

function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function distanceToNearestBomb(state, pid) {
  const p = state.players.find((pl) => pl.id === pid);
  if (!p) return 999;
  let best = 999;
  for (const b of state.bombs) {
    best = Math.min(best, Math.abs(b.x - p.x) + Math.abs(b.y - p.y));
  }
  return best === 999 ? 999 : best;
}

function potentialKills(state, pid) {
  // simplistic: count number of enemies within a cell that a bomb placed now by pid could reach after 1 tick
  const p = state.players.find((pl) => pl.id === pid);
  if (!p) return 0;
  let kills = 0;
  // if place bomb at current pos with range p.bombRange, see which enemies are on explosion tiles
  const r = p.bombRange;
  const tiles = new Set([`${p.x},${p.y}`]);
  for (const dir of Object.values(DIRS).slice(0, 4)) {
    for (let dist = 1; dist <= r; dist++) {
      const nx = p.x + dir[0] * dist,
        ny = p.y + dir[1] * dist;
      if (!state.inBounds(nx, ny)) break;
      const c = state.getCell(nx, ny);
      tiles.add(`${nx},${ny}`);
      if (c === "#") break;
      if (c === "X") break;
    }
  }
  for (const other of state.players) {
    if (other.id === pid) continue;
    if (!other.alive) continue;
    if (tiles.has(`${other.x},${other.y}`)) kills += 1;
  }
  return kills;
}

function isInDeadEnd(state, pid) {
  const p = state.players.find((pl) => pl.id === pid);
  if (!p) return false;
  // dead-end = only one adjacent free cell (or zero)
  let free = 0;
  for (const d of Object.values(DIRS).slice(0, 4)) {
    const nx = p.x + d[0],
      ny = p.y + d[1];
    if (!state.inBounds(nx, ny)) continue;
    const cell = state.getCell(nx, ny);
    const bombAt = state.bombs.some((b) => b.x === nx && b.y === ny);
    if (cell !== "#" && cell !== "X" && !bombAt) free++;
  }
  return free <= 1;
}

/* ===========================
   Beam Search Agent
   =========================== */

class BeamNode {
  constructor(state, actions, score) {
    this.state = state;
    this.actions = actions;
    this.score = score;
  }
}

class BeamAgent {
  constructor(playerId, options = {}) {
    this.playerId = playerId;
    this.maxDepth = options.maxDepth || 6;
    this.beamWidth = options.beamWidth || 40;
    this.timeLimitMs = options.timeLimitMs || 60; // ms
  }

  getLegalActions(state, pid) {
    const p = state.players.find((pl) => pl.id === pid);
    if (!p || !p.alive) return [{ type: "STAY" }];
    const res = [];
    for (const a of ACTIONS) {
      if (a.type === "MOVE") {
        const d = DIRS[a.dir];
        const nx = p.x + d[0],
          ny = p.y + d[1];
        if (!state.inBounds(nx, ny)) continue;
        const cell = state.getCell(nx, ny);
        const bombAt = state.bombs.some((b) => b.x === nx && b.y === ny);
        if (cell === "#" || cell === "X" || bombAt) continue;
        res.push(a);
      } else if (a.type === "BOMB") {
        if (
          p.bombsCount > 0 &&
          !state.bombs.some((b) => b.x === p.x && b.y === p.y)
        )
          res.push(a);
      } else if (a.type === "STAY") {
        res.push(a);
      }
    }
    return res.length ? res : [{ type: "STAY" }];
  }

  evaluateState(state, pid) {
    // composite heuristic - tuned heuristically
    const p = state.players.find((pl) => pl.id === pid);
    if (!p || !p.alive) return -1e9;

    let score = 0;
    // survival importance
    score += p.alive ? 1000 : 0;

    // distance from nearest bomb (prefer far)
    const dBomb = distanceToNearestBomb(state, pid);
    score += Math.min(dBomb, 6) * 25;

    // powerups nearby
    let puNear = 0;
    for (const pu of state.powerups) {
      const dist = Math.abs(pu.x - p.x) + Math.abs(pu.y - p.y);
      if (dist <= 3) puNear++;
    }
    score += puNear * 120;

    // potential kills
    score += potentialKills(state, pid) * 350;

    // avoid dead ends
    if (isInDeadEnd(state, pid)) score -= 200;

    // encourage staying alive longer (tick)
    score += state.tick * 1;

    // small prefer to be in center (heuristic)
    const centerDist =
      Math.abs(p.x - Math.floor(state.width / 2)) +
      Math.abs(p.y - Math.floor(state.height / 2));
    score -= centerDist * 2;

    return score;
  }

  hashStateForDedup(state, pid) {
    const p = state.players.find((pl) => pl.id === pid);
    const bombsHash = state.bombs
      .map((b) => `${b.x}:${b.y}:${b.timer}`)
      .sort()
      .join("|");
    const playersHash = state.players
      .map((pl) => `${pl.id}:${pl.x},${pl.y},${pl.alive ? 1 : 0}`)
      .sort()
      .join("|");
    return `${p.x},${p.y}|${bombsHash}|${playersHash}|${state.tick}`;
  }

  simulateSequence(rootState, myActionSeq, opponentsActionSeqs = {}) {
    // opponentsActionSeqs: map pid -> array of actions to use per tick (optional)
    const st = clone(rootState);
    // step through sequence length
    for (let i = 0; i < myActionSeq.length; i++) {
      const actionsByPlayer = {};
      // my action at this tick
      actionsByPlayer[this.playerId] = myActionSeq[i] || { type: "STAY" };
      // opponents: use provided seq or simple random heuristic (stay or move away)
      for (const pl of st.players) {
        if (pl.id === this.playerId) continue;
        const seq = opponentsActionSeqs[pl.id];
        if (seq && i < seq.length) {
          actionsByPlayer[pl.id] = seq[i];
        } else {
          // basic opponent model: random legal action biased to move if near bombs
          actionsByPlayer[pl.id] = this.simpleOpponentPolicy(st, pl.id);
        }
      }
      tickState(st, actionsByPlayer);
    }
    return st;
  }

  simpleOpponentPolicy(state, pid) {
    const acts = this.getLegalActions(state, pid);
    // very simple: prefer to move away from bombs if close
    const dBomb = distanceToNearestBomb(state, pid);
    if (dBomb <= 2) {
      // pick a move that increases distance to nearest bomb if possible
      const p = state.players.find((pl) => pl.id === pid);
      let best = acts[0];
      let bestDist = -1;
      for (const a of acts) {
        if (a.type === "MOVE") {
          const d = DIRS[a.dir];
          const nx = p.x + d[0],
            ny = p.y + d[1];
          let minDist = Infinity;
          for (const b of state.bombs)
            minDist = Math.min(
              minDist,
              Math.abs(b.x - nx) + Math.abs(b.y - ny)
            );
          if (minDist > bestDist) {
            bestDist = minDist;
            best = a;
          }
        }
      }
      return best;
    }
    // else random
    return acts[Math.floor(Math.random() * acts.length)];
  }

  chooseAction(rootState) {
    const start = performance.now();
    const rootNode = new BeamNode(
      clone(rootState),
      [],
      this.evaluateState(rootState, this.playerId)
    );
    let beam = [rootNode];
    let bestNode = rootNode;
    const visitedHashes = new Set();

    for (let depth = 0; depth < this.maxDepth; depth++) {
      if (performance.now() - start > this.timeLimitMs) break;
      const candidates = [];
      for (const node of beam) {
        const legal = this.getLegalActions(node.state, this.playerId);
        for (const act of legal) {
          // build action sequence for this node
          const seq = [...node.actions, act];
          // quick simulate one tick (simulateSequence handles opponents)
          const simState = this.simulateSequence(node.state, [act]);
          // if dead, skip
          const me = simState.players.find((pl) => pl.id === this.playerId);
          if (!me || !me.alive) continue;
          const score = this.evaluateState(simState, this.playerId);
          const newNode = new BeamNode(simState, seq, score);
          candidates.push(newNode);
          if (score > bestNode.score) bestNode = newNode;
        }
      }
      // sort and keep top beamWidth
      candidates.sort((a, b) => b.score - a.score);
      let top = candidates.slice(0, this.beamWidth);

      // dedupe by hashed state (to avoid same states)
      const deduped = [];
      const seen = new Set();
      for (const n of top) {
        const h = this.hashStateForDedup(n.state, this.playerId);
        if (!seen.has(h)) {
          deduped.push(n);
          seen.add(h);
        }
      }
      beam = deduped;
      if (beam.length === 0) break;
    }

    // return first action of best node
    if (!bestNode || bestNode.actions.length === 0) return { type: "STAY" };
    return bestNode.actions[0];
  }
}

/* ===========================
   Random Agent (for testing)
   =========================== */
class RandomAgent {
  constructor(playerId) {
    this.playerId = playerId;
  }
  chooseAction(state) {
    const possible = [];
    // replicate BeamAgent getLegalActions logic quickly
    const p = state.players.find((pl) => pl.id === this.playerId);
    if (!p || !p.alive) return { type: "STAY" };
    for (const a of ACTIONS) {
      if (a.type === "MOVE") {
        const d = DIRS[a.dir];
        const nx = p.x + d[0],
          ny = p.y + d[1];
        if (!state.inBounds(nx, ny)) continue;
        const cell = state.getCell(nx, ny);
        const bombAt = state.bombs.some((b) => b.x === nx && b.y === ny);
        if (cell === "#" || cell === "X" || bombAt) continue;
        possible.push(a);
      } else if (a.type === "BOMB") {
        if (
          p.bombsCount > 0 &&
          !state.bombs.some((b) => b.x === p.x && b.y === p.y)
        )
          possible.push(a);
      } else possible.push(a);
    }
    if (possible.length === 0) return { type: "STAY" };
    return possible[Math.floor(Math.random() * possible.length)];
  }
}

/* ===========================
   Example match runner
   =========================== */

function createDefaultMap() {
  // small 9x7 map example; '#' walls border, some crates 'X'
  const layout = [
    "#########",
    "#...X...#",
    "#.X...X.#",
    "#...P...#",
    "#.X...X.#",
    "#...X...#",
    "#########",
  ];
  return layout.map((row) => row.split(""));
}

function spawnPlayers(state) {
  state.players = [
    { id: "A", x: 1, y: 1, alive: true, bombsCount: 1, bombRange: 2 },
    {
      id: "B",
      x: state.width - 2,
      y: state.height - 2,
      alive: true,
      bombsCount: 1,
      bombRange: 2,
    },
  ];
}

// run a simple match
function runMatch() {
  const map = createDefaultMap();
  const state = new GameState(map[0].length, map.length, map);
  spawnPlayers(state);

  // initial powerups empty
  state.powerups = [];

  const agentA = new BeamAgent("A", {
    maxDepth: 6,
    beamWidth: 30,
    timeLimitMs: 40,
  });
  const agentB = new RandomAgent("B");

  const maxTicks = 200;
  let tick = 0;
  while (tick < maxTicks && state.players.some((p) => p.alive)) {
    const actA = agentA.chooseAction(state);
    const actB = agentB.chooseAction(state);
    tickState(state, { A: actA, B: actB });
    tick++;
    // logging
    // console.log(`Tick ${tick}: A->${actA.type}${actA.dir ? ':'+actA.dir : ''}, B->${actB.type}${actB.dir ? ':'+actB.dir : ''}`);
  }

  const aAlive = state.players.find((p) => p.id === "A").alive;
  const bAlive = state.players.find((p) => p.id === "B").alive;

  console.log("Match ended in", tick, "ticks. Alive A:", aAlive, "B:", bAlive);
  console.log("Final players:", state.players);
}

// run several matches to see winrate
function runTournament(n = 10) {
  let aWins = 0,
    bWins = 0,
    ties = 0;
  for (let i = 0; i < n; i++) {
    runMatch();
    // we used console.log inside runMatch, so result already printed; for clarity we won't re-evaluate here
    // In a better harness we'd return result; keeping it simple
  }
}

// if executed directly, run a match
if (require.main === module) {
  runMatch();
}
