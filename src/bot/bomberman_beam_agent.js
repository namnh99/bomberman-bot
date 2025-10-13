// bomberman_chest_bomb_agent.js
// Run: const { decideNextAction } = require('./bomberman_chest_bomb_agent');

import { STEP_COUNT } from "../constants/index.js";

const DIRS = [
  [0, -1, "UP"],
  [0, 1, "DOWN"],
  [-1, 0, "LEFT"],
  [1, 0, "RIGHT"],
];

const WALKABLE = [null, "B", "R", "S"]; // Empty spaces and all items are walkable
const BREAKABLE = ["C"]; // Only Chests are breakable

// Strategic values for different items
const ITEM_VALUES = {
  S: 3.0, // Speed - very valuable for mobility and escaping
  R: 2.5, // Explosion Range - valuable for destroying more chests
  B: 2.0, // Bomb Count - valuable for offensive play
};

const ITEM_PRIORITY_BIAS = 2; // Bot will prefer items if path is 2 steps longer than chest
let recentlyBombed = []; // Memory of recently bombed locations to avoid loops.
const RECENT_BOMB_MEMORY = 3; // How many recent bombs to remember.

// Anti-oscillation: Track last position and decision to prevent immediate backtracking
let lastPosition = null;
let lastDecision = null;
let decisionCount = 0;

// Helper to track decisions
function trackDecision(player, action) {
  const posKey = `${player.x},${player.y}`;
  lastPosition = posKey;
  lastDecision = action;
}

/* ================================
   1️⃣ Utility Functions
   ================================ */

function findAllItems(map, bombs, allBombers, myBomber) {
  const items = [];
  const unsafeTiles = findUnsafeTiles(map, bombs, allBombers, myBomber);
  for (let y = 0; y < map.length; y++) {
    for (let x = 0; x < map[y].length; x++) {
      const cell = map[y][x];
      // Ignore items in a blast zone
      if (["B", "R", "S"].includes(cell) && !unsafeTiles.has(`${x},${y}`)) {
        items.push({ x, y, type: cell, value: ITEM_VALUES[cell] || 1 });
      }
    }
  }
  return items;
}

function findAllChests(map, bombs, allBombers, myBomber) {
  const targets = [];
  const unsafeTiles = findUnsafeTiles(map, bombs, allBombers, myBomber);
  for (let y = 0; y < map.length; y++) {
    for (let x = 0; x < map[y].length; x++) {
      // Ignore chests in a blast zone
      if (map[y][x] === "C" && !unsafeTiles.has(`${x},${y}`)) {
        targets.push({ x, y });
      }
    }
  }
  return targets;
}

/**
 * A unified BFS that finds the best path to a target, avoiding active bomb zones
 * and keeping track of breakable chests in the way.
 */
function findBestPath(
  map,
  start,
  targets,
  bombs,
  allBombers,
  myBomber,
  isEscaping = false
) {
  const h = map.length;
  const w = map[0].length;
  const queue = [[start.x, start.y, [], []]]; // [x, y, path, walls]
  const visited = new Set([`${start.x},${start.y}`]);

  // Pre-calculate unsafe tiles for O(1) lookup and better performance
  const unsafeTiles = new Set();
  for (const bomb of bombs) {
    if (bomb.isExploded) continue;

    const owner = allBombers.find((b) => b.uid === bomb.uid);
    const range = owner ? owner.explosionRange : 2;

    const gridBombX = Math.floor(bomb.x / STEP_COUNT);
    const gridBombY = Math.floor(bomb.y / STEP_COUNT);

    unsafeTiles.add(`${gridBombX},${gridBombY}`);
    for (const [dx, dy] of DIRS) {
      for (let step = 1; step <= range; step++) {
        const nx = gridBombX + dx * step;
        const ny = gridBombY + dy * step;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) break;
        if (map[ny][nx] === "W") break;
        unsafeTiles.add(`${nx},${ny}`);
      }
    }
  }

  while (queue.length) {
    const [x, y, path, walls] = queue.shift();

    if (
      targets.some((t) => {
        if (isEscaping)
          return t.x === x && t.y === y && !unsafeTiles.has(`${t.x},${t.y}`);
        return t.x === x && t.y === y;
      })
    ) {
      return { path, walls };
    }

    for (const [dx, dy, dir] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      const key = `${nx},${ny}`;

      if (nx < 0 || ny < 0 || nx >= w || ny >= h || visited.has(key)) {
        continue;
      }

      // CRITICAL FIX: When not escaping, NEVER enter bomb zones
      // This prevents the bot from walking back into danger after escaping
      if (!isEscaping && unsafeTiles.has(key)) {
        console.log(
          `   ⚠️  Avoiding bomb zone at [${nx}, ${ny}] while pathfinding`
        );
        continue;
      }

      // When escaping, only prevent going from safe to unsafe
      // (allow moving through unsafe zones to reach safety)
      if (isEscaping) {
        const isCurrentTileSafe = !unsafeTiles.has(`${x},${y}`);
        if (isCurrentTileSafe && unsafeTiles.has(key)) {
          continue;
        }
      }

      const cell = map[ny][nx];
      if (WALKABLE.includes(cell)) {
        visited.add(key);
        const newPath = [...path, dir];
        const newWalls = BREAKABLE.includes(cell)
          ? [...walls, { x: nx, y: ny }]
          : walls;
        queue.push([nx, ny, newPath, newWalls]);
      }
    }
  }

  return null; // No path found
}

/**
 * Find the FASTEST path to the nearest safe tile using optimized BFS
 * Returns immediately when first safe tile is found (guaranteed shortest)
 */
function findShortestEscapePath(map, start, bombs, allBombers, myBomber) {
  const h = map.length;
  const w = map[0].length;

  // Pre-calculate all unsafe tiles for O(1) lookup instead of checking each time
  const unsafeTiles = new Set();
  for (const bomb of bombs) {
    if (bomb.isExploded) continue;

    const owner = allBombers.find((b) => b.uid === bomb.uid);
    const range = owner ? owner.explosionRange : 2;

    const gridBombX = Math.floor(bomb.x / STEP_COUNT);
    const gridBombY = Math.floor(bomb.y / STEP_COUNT);

    unsafeTiles.add(`${gridBombX},${gridBombY}`);

    for (const [dx, dy] of DIRS) {
      for (let step = 1; step <= range; step++) {
        const nx = gridBombX + dx * step;
        const ny = gridBombY + dy * step;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) break;
        if (map[ny][nx] === "W") break;
        unsafeTiles.add(`${nx},${ny}`);
      }
    }
  }

  // BFS queue: [x, y, path]
  const queue = [[start.x, start.y, []]];
  const visited = new Set([`${start.x},${start.y}`]);

  while (queue.length) {
    const [x, y, path] = queue.shift();

    // Check if current position is safe (O(1) lookup)
    if (!unsafeTiles.has(`${x},${y}`)) {
      // Found the nearest safe tile! Return immediately
      if (path.length > 0) {
        return { path, target: { x, y }, distance: path.length };
      }
      // Already safe at start (shouldn't happen in escape scenario)
      return null;
    }

    // Explore all 4 directions
    for (const [dx, dy, dir] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      const key = `${nx},${ny}`;

      // Bounds check and visited check
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || visited.has(key)) {
        continue;
      }

      const cell = map[ny][nx];
      // Only walk through empty spaces and items (not walls or chests)
      if (WALKABLE.includes(cell)) {
        visited.add(key);
        queue.push([nx, ny, [...path, dir]]);
      }
    }
  }

  return null; // No escape route found
}

/**
 * Helper function to get a set of all coordinates currently in an explosion radius.
 */
function findUnsafeTiles(map, bombs = [], allBombers = [], myBomber) {
  const unsafeCoords = new Set();
  const h = map.length;
  const w = map[0].length;

  for (const bomb of bombs) {
    if (bomb.isExploded) continue;

    let range;
    if (bomb.uid) {
      const owner = allBombers.find((b) => b.uid === bomb.uid);
      range = owner ? owner.explosionRange : 2;
    } else {
      range = bomb.range || myBomber?.explosionRange || 3;
    }

    const gridBombX = Math.floor(bomb.x / STEP_COUNT);
    const gridBombY = Math.floor(bomb.y / STEP_COUNT);

    unsafeCoords.add(`${gridBombX},${gridBombY}`);
    for (const [dx, dy] of DIRS) {
      for (let step = 1; step <= range; step++) {
        const nx = gridBombX + dx * step;
        const ny = gridBombY + dy * step;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) break;
        if (map[ny][nx] === "W") break;
        unsafeCoords.add(`${nx},${ny}`);
      }
    }
  }
  return unsafeCoords;
}

/**
 * Find safe empty tiles (not inside explosion radius)
 */
function findSafeTiles(map, bombs = [], allBombers = [], myBomber) {
  const safeTiles = [];
  const h = map.length;
  const w = map[0].length;

  function inExplosionRadius(x, y) {
    for (const bomb of bombs) {
      if (bomb.isExploded) continue; // Ignore exploded bombs

      // This is an existing bomb on the map
      const owner = allBombers.find((b) => b.uid === bomb.uid);
      const range = owner ? owner.explosionRange : 2;

      const gridBombX = Math.floor(bomb.x / STEP_COUNT);
      const gridBombY = Math.floor(bomb.y / STEP_COUNT);

      // The above simple check is not enough as walls block explosions.
      // We need to check line-of-sight.
      if (gridBombX === x && gridBombY === y) return true;
      for (const [dx, dy] of DIRS) {
        for (let step = 1; step <= range; step++) {
          const nx = gridBombX + dx * step;
          const ny = gridBombY + dy * step;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) break;
          // Permanent walls 'W' stop explosions.
          if (map[ny][nx] === "W") break;
          if (nx === x && ny === y) return true;
        }
      }
    }
    return false;
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (map[y][x] === null && !inExplosionRadius(x, y)) {
        safeTiles.push({ x, y });
      }
    }
  }

  return safeTiles;
}

function handleTarget(result, state, myUid) {
  const { map, bombs = [], bombers } = state;
  // Filter out exploded bombs
  const activeBombs = bombs.filter((b) => !b.isExploded);

  const myBomber = bombers?.find((b) => b.uid === myUid);
  const player = {
    x: Math.floor(myBomber.x / 40),
    y: Math.floor(myBomber.y / 40),
  };

  console.log(
    `   Path: ${result.path.join(" → ")} (${result.path.length} steps)`
  );
  console.log(`   Walls blocking: ${result.walls.length}`);

  // If path is blocked by a chest, handle it
  if (result.walls.length > 0) {
    const targetWall = result.walls[0];
    console.log(
      `   First blocking wall at: [${targetWall.x}, ${targetWall.y}]`
    );

    if (
      Math.abs(targetWall.x - player.x) + Math.abs(targetWall.y - player.y) ===
      1
    ) {
      console.log("   🧱 Chest is adjacent! Considering bombing...");

      const futureBombs = [
        ...activeBombs,
        {
          x: player.x * 40,
          y: player.y * 40,
          explosionRange: myBomber.explosionRange,
        },
      ];
      const futureSafeTiles = findSafeTiles(
        state.map,
        futureBombs,
        bombers,
        myBomber
      );
      console.log(`   Future safe tiles: ${futureSafeTiles.length}`);

      if (futureSafeTiles.length > 0) {
        // Use the safe pathfinder for escaping the planned bomb
        const escapePath = findBestPath(
          map,
          player,
          futureSafeTiles,
          futureBombs,
          bombers,
          myBomber,
          true // isEscaping = true (can cross danger to reach safety)
        );

        if (escapePath && escapePath.path.length > 0) {
          console.log(`   ✅ Escape path: ${escapePath.path.join(" → ")}`);
          console.log("🎯 DECISION: BOMB + ESCAPE (blocking chest)");
          console.log(
            "   💣 Bombing wall at",
            `[${targetWall.x}, ${targetWall.y}]`
          );
          console.log("   🏃 Escape action:", escapePath.path[0]);
          console.log("=".repeat(60) + "\n");
          if (myBomber.bombCount) {
            return { action: "BOMB", escapeAction: escapePath.path[0] };
          }
        } else {
          console.log(`   ❌ No escape path found`);
        }
      } else {
        console.log(`   ❌ No safe tiles after bombing`);
      }
    } else {
      console.log(`   Wall not adjacent, need to move closer first`);
    }
    console.log("🎯 DECISION: STAY (Not safe to bomb blocking chest)");
    console.log("=".repeat(60) + "\n");
    return { action: "STAY" }; // Not safe to bomb
  }

  // Move towards target or the blocking chest
  if (result.path.length > 0) {
    console.log("🎯 DECISION: MOVE (towards target)");
    console.log("   Action:", result.path[0]);
    console.log("=".repeat(60) + "\n");
    trackDecision(player, result.path[0]); // Track decision
    return { action: result.path[0] };
  }

  console.log("🎯 DECISION: STAY (No path)");
  console.log("=".repeat(60) + "\n");
  trackDecision(player, "STAY"); // Track decision
  return { action: "STAY" };
}

/* ================================
   2️⃣ Core Decision Logic
   ================================ */

export function decideNextAction(state, myUid) {
  const { map, bombs = [], bombers } = state;
  const myBomber = bombers?.find((b) => b.uid === myUid);

  console.log("\n" + "=".repeat(60));
  console.log("🤖 BOT DECISION CYCLE STARTED");
  console.log("=".repeat(60));

  if (!myBomber || !myBomber.isAlive) {
    console.warn("⚠️ No active bomber found for UID:", myUid);
    return { action: "STAY" };
  }

  // convert to grid coordinate
  const player = {
    x: Math.floor(myBomber.x / STEP_COUNT),
    y: Math.floor(myBomber.y / STEP_COUNT),
  };

  // Anti-oscillation check: Detect if we're bouncing between same positions
  const currentPosKey = `${player.x},${player.y}`;
  if (lastPosition === currentPosKey && lastDecision) {
    decisionCount++;
    if (decisionCount >= 2) {
      console.log(
        `⚠️ OSCILLATION DETECTED! Been at [${player.x}, ${player.y}] ${decisionCount} times`
      );
      console.log(`   Last decision was: ${lastDecision}`);
      console.log(`   🔄 Breaking loop by forcing original decision`);
      // Keep the same decision to commit to the path
      lastPosition = null; // Reset after forcing decision
      decisionCount = 0;
      return { action: lastDecision };
    }
  } else {
    // Different position or first decision, reset counter
    decisionCount = 0;
  }

  console.log("📍 Player Position:", {
    grid: `[${player.x}, ${player.y}]`,
    pixel: `[${myBomber.x}, ${myBomber.y}]`,
    orient: myBomber.orient,
  });
  console.log("📊 Player Stats:", {
    bombCount: myBomber.bombCount,
    explosionRange: myBomber.explosionRange,
    speed: myBomber.speed,
    isAlive: myBomber.isAlive,
  });
  console.log("💣 Total Bombs in State:", bombs.length);

  // Debug: Show all bombs and their status
  if (bombs.length > 0) {
    console.log("   Bomb Details:");
    bombs.forEach((bomb, idx) => {
      const gridX = Math.floor(bomb.x / STEP_COUNT);
      const gridY = Math.floor(bomb.y / STEP_COUNT);
      console.log(
        `   Bomb ${idx + 1}: [${gridX}, ${gridY}] | isExploded: ${
          bomb.isExploded || false
        } | uid: ${bomb.uid || "N/A"}`
      );
    });
  }

  // Filter out exploded bombs
  const activeBombs = bombs.filter((b) => !b.isExploded);
  console.log("💣 Active (non-exploded) Bombs:", activeBombs.length);
  console.log("👥 Active Bombers:", bombers.filter((b) => b.isAlive).length);

  // 🚨 High-priority: Escape from bomb blasts
  console.log("\n🔍 PHASE 1: Safety Check");
  const safeTiles = findSafeTiles(map, activeBombs, bombers, myBomber);
  const isPlayerSafe = activeBombs.length
    ? safeTiles.some((tile) => tile.x === player.x && tile.y === player.y)
    : true;

  console.log(`   Safety Status: ${isPlayerSafe ? "✅ SAFE" : "🚨 DANGER"}`);
  console.log(`   Safe Tiles Available: ${safeTiles.length}`);

  if (!isPlayerSafe) {
    console.log(
      `   🚨 UNSAFE at [${player.x}, ${player.y}]! Finding shortest escape route...`
    );

    // Use BFS to find the SHORTEST path to ANY safe tile
    const escapeResult = findShortestEscapePath(
      map,
      player,
      activeBombs,
      bombers,
      myBomber
    );

    if (escapeResult && escapeResult.path.length > 0) {
      console.log(
        `   ✅ Shortest escape path found: ${escapeResult.path.join(" → ")}`
      );
      console.log(
        `   Target safe tile: [${escapeResult.target.x}, ${escapeResult.target.y}]`
      );
      console.log(`   Distance: ${escapeResult.distance} steps`);
      console.log("🎯 DECISION: ESCAPE (shortest path to safety)");
      console.log("   Action:", escapeResult.path[0]);
      console.log("=".repeat(60) + "\n");
      trackDecision(player, escapeResult.path[0]); // Track escape decision
      return {
        action: escapeResult.path[0],
        isEscape: true,
        fullPath: escapeResult.path, // Return the FULL escape path
      };
    }

    // No escape route found, try to move to any adjacent walkable tile
    console.log("   ⚠️ No direct escape path, trying emergency moves...");
    for (const [dx, dy, dir] of DIRS) {
      const nx = player.x + dx;
      const ny = player.y + dy;
      if (nx >= 0 && ny >= 0 && nx < map[0].length && ny < map.length) {
        const cell = map[ny][nx];
        if (WALKABLE.includes(cell)) {
          console.log(`   🚨 Emergency move: ${dir}`);
          console.log("🎯 DECISION: EMERGENCY ESCAPE");
          console.log("   Action:", dir);
          console.log("=".repeat(60) + "\n");
          trackDecision(player, dir); // Track emergency decision
          return { action: dir };
        }
      }
    }

    // Absolutely no escape route, brace for impact
    console.log("   ❌ No escape possible! Bracing for impact.");
    console.log("🎯 DECISION: STAY (No escape)");
    console.log("=".repeat(60) + "\n");
    trackDecision(player, "STAY"); // Track stay decision
    return { action: "STAY" };
  }

  // Strategy:
  // 1. Find paths to both nearest item and nearest chest.
  // 2. Compare path lengths and choose the better target.
  // 3. If a chest blocks the path, bomb it.
  // 4. If at a tile adjacent to a target chest, bomb it.
  // 5. If no targets, explore.

  console.log("\n🔍 PHASE 2: Target Analysis");

  // 1️⃣ Find path to nearest item (that is not in a danger zone)
  const items = findAllItems(map, activeBombs, bombers, myBomber);
  console.log(`   Items found: ${items.length}`);
  if (items.length > 0) {
    console.log(
      `   Item locations:`,
      items
        .slice(0, 3)
        .map((i) => `[${i.x},${i.y}]`)
        .join(", ")
    );
  }

  const itemResult = items.length
    ? findBestPath(map, player, items, activeBombs, bombers, myBomber)
    : null;

  if (itemResult) {
    console.log(
      `   ✅ Path to item: ${itemResult.path.join(" → ")} (${
        itemResult.path.length
      } steps)`
    );
  } else if (items.length > 0) {
    console.log(`   ❌ No path to items found`);
  }

  // 2️⃣ Find path to nearest chest (that is not in a danger zone)
  const chests = findAllChests(map, activeBombs, bombers, myBomber);
  console.log(`   Chests found: ${chests.length}`);
  if (chests.length > 0) {
    console.log(
      `   Chest locations:`,
      chests
        .slice(0, 3)
        .map((c) => `[${c.x},${c.y}]`)
        .join(", ")
    );
  }

  let chestResult = null;
  if (chests.length) {
    // Are we already next to a chest? If so, that's our primary chest action.
    const adjacentChest = chests.find((c) => {
      const dx = Math.abs(c.x - player.x);
      const dy = Math.abs(c.y - player.y);
      return (dx === 1 && dy === 0) || (dx === 0 && dy === 1);
    });
    if (adjacentChest) {
      console.log(`\n🔍 PHASE 3: Adjacent Chest Bombing`);
      console.log(
        `   🧱 Adjacent chest at [${adjacentChest.x}, ${adjacentChest.y}]`
      );

      if (myBomber.bombCount) {
        // Add to memory before deciding to bomb
        recentlyBombed.push({ x: adjacentChest.x, y: adjacentChest.y });
        if (recentlyBombed.length > RECENT_BOMB_MEMORY) {
          recentlyBombed.shift(); // Keep memory size limited
        }

        const futureBombs = [
          ...activeBombs,
          {
            x: player.x * STEP_COUNT,
            y: player.y * STEP_COUNT,
            explosionRange: myBomber.explosionRange,
            uid: myBomber.uid,
          },
        ];
        // Find an escape path from our planned bomb
        const futureSafeTiles = findSafeTiles(
          map,
          futureBombs,
          bombers,
          myBomber
        );
        console.log(
          `   Future safe tiles after bombing: ${futureSafeTiles.length}`
        );

        if (futureSafeTiles.length > 0) {
          const escapePath = findBestPath(
            map,
            player,
            futureSafeTiles,
            futureBombs,
            bombers,
            myBomber,
            true // isEscaping = true (can cross danger to reach safety)
          );

          if (escapePath && escapePath.path.length > 0) {
            console.log(
              `   ✅ Escape path found: ${escapePath.path.join(" → ")}`
            );
            console.log("🎯 DECISION: BOMB + ESCAPE");
            console.log(
              "   💣 Bombing chest at",
              `[${adjacentChest.x}, ${adjacentChest.y}]`
            );
            console.log("   🏃 Escape action:", escapePath.path[0]);
            console.log("=".repeat(60) + "\n");
            if (myBomber.bombCount) {
              return { action: "BOMB", escapeAction: escapePath.path[0] };
            }
          } else {
            console.log(`   ❌ No escape path found after bombing`);
          }
        } else {
          console.log(`   ❌ No safe tiles after bombing`);
        }
      } else {
        console.log(`   ❌ No bombs available`);
      }

      console.log("🎯 DECISION: STAY (Not safe to bomb)");
      console.log("=".repeat(60) + "\n");
      return { action: "STAY" }; // Not safe to bomb or no bombs left
    }

    // Find walkable tiles adjacent to any chest
    const adjacentTargets = [];
    for (const chest of chests) {
      for (const [dx, dy] of DIRS) {
        const adjX = chest.x + dx;
        const adjY = chest.y + dy;
        if (map[adjY] && WALKABLE.includes(map[adjY][adjX])) {
          adjacentTargets.push({ x: adjX, y: adjY });
        }
      }
    }
    console.log(`   Adjacent chest targets: ${adjacentTargets.length}`);

    if (adjacentTargets.length) {
      chestResult = findBestPath(
        map,
        player,
        adjacentTargets,
        activeBombs,
        bombers,
        myBomber
      );
      if (chestResult) {
        console.log(
          `   ✅ Path to chest: ${chestResult.path.join(" → ")} (${
            chestResult.path.length
          } steps)`
        );
      }
    }
  }

  // 3️⃣ Compare targets and decide
  console.log(`\n🔍 PHASE 4: Target Prioritization`);
  let chosenResult = null;
  let targetType = null;

  if (itemResult && chestResult) {
    console.log(
      `   Comparing: Item(${itemResult.path.length}) vs Chest(${chestResult.path.length}) + Bias(${ITEM_PRIORITY_BIAS})`
    );
    if (
      itemResult.path.length <=
      chestResult.path.length + ITEM_PRIORITY_BIAS
    ) {
      console.log("   ✅ Prioritizing ITEM over chest");
      chosenResult = itemResult;
      targetType = "ITEM";
    } else {
      console.log("   ✅ Prioritizing CHEST over item");
      chosenResult = chestResult;
      targetType = "CHEST";
    }
  } else if (itemResult) {
    console.log("   ✅ Only ITEM found");
    chosenResult = itemResult;
    targetType = "ITEM";
  } else if (chestResult) {
    console.log("   ✅ Only CHEST found");
    chosenResult = chestResult;
    targetType = "CHEST";
  } else {
    console.log("   ❌ No items or chests found");
  }

  // 4️⃣ Execute action for the chosen target
  if (chosenResult) {
    console.log(`\n🔍 PHASE 5: Target Execution (${targetType})`);
    return handleTarget(chosenResult, state, myUid);
  }

  // 5️⃣ No targets found, explore
  console.log(`\n🔍 PHASE 6: Exploration Mode`);
  console.log(`   Safe exploration tiles: ${safeTiles.length}`);

  if (safeTiles.length > 0) {
    const explorePath = findBestPath(
      map,
      player,
      safeTiles,
      activeBombs, // FIX: Use activeBombs instead of bombs
      bombers,
      myBomber
    );
    if (explorePath && explorePath.path.length > 0) {
      console.log(`   ✅ Exploration path: ${explorePath.path.join(" → ")}`);
      console.log("🎯 DECISION: EXPLORE");
      console.log("   Action:", explorePath.path[0]);
      console.log("=".repeat(60) + "\n");
      trackDecision(player, explorePath.path[0]); // Track explore decision
      return { action: explorePath.path[0] };
    } else {
      console.log(`   ❌ No exploration path found`);
    }
  }

  console.log("🎯 DECISION: STAY (No options)");
  console.log("=".repeat(60) + "\n");
  trackDecision(player, "STAY"); // Track final stay decision
  return { action: "STAY" };
}
