// bomberman_chest_bomb_agent.js
// Run: const { decideNextAction } = require('./bomberman_chest_bomb_agent');

const DIRS = [
  [0, -1, "UP"],
  [0, 1, "DOWN"],
  [-1, 0, "LEFT"],
  [1, 0, "RIGHT"],
];

const WALKABLE = [null, "B", "R", "S"]; // Empty spaces and all items are walkable
const BREAKABLE = ["C"]; // Only Chests are breakable
const ITEM_PRIORITY_BIAS = 5; // Bot will prefer an item if its path is no more than 5 steps longer than the path to a chest.
let recentlyBombed = []; // Memory of recently bombed locations to avoid loops.
const RECENT_BOMB_MEMORY = 3; // How many recent bombs to remember.

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
        items.push({ x, y });
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

  function inExplosionRadius(x, y) {
    for (const bomb of bombs) {
      if (bomb.isExploded) continue;

      const owner = allBombers.find((b) => b.uid === bomb.uid);
      const range = owner ? owner.explosionRange : 2;

      const gridBombX = Math.floor(bomb.x / 40);
      const gridBombY = Math.floor(bomb.y / 40);

      if (gridBombX === x && gridBombY === y) return true;
      for (const [dx, dy] of DIRS) {
        for (let step = 1; step <= range; step++) {
          const nx = gridBombX + dx * step;
          const ny = gridBombY + dy * step;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) break;
          if (map[ny][nx] === "W") break;
          if (nx === x && ny === y) return true;
        }
      }
    }
    return false;
  }

  while (queue.length) {
    const [x, y, path, walls] = queue.shift();

    if (
      targets.some((t) => {
        if (isEscaping)
          return t.x === x && t.y === y && !inExplosionRadius(t.x, t.y);
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

      // If the current tile in the search is safe, the next one must also be safe.
      // This prevents the bot from ever plotting a path from a safe space into a danger zone.
      const isCurrentTileSafe = !inExplosionRadius(x, y);
      if (isCurrentTileSafe && inExplosionRadius(nx, ny)) {
        continue;
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

  return null; // Không tìm thấy đường đi
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

    const gridBombX = Math.floor(bomb.x / 40);
    const gridBombY = Math.floor(bomb.y / 40);

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

      const gridBombX = Math.floor(bomb.x / 40);
      const gridBombY = Math.floor(bomb.y / 40);

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
  const myBomber = bombers?.find((b) => b.uid === myUid);
  const player = {
    x: Math.floor(myBomber.x / 40),
    y: Math.floor(myBomber.y / 40),
  };

  console.log("result:", result);

  // If path is blocked by a chest, handle it
  if (result.walls.length > 0) {
    const targetWall = result.walls[0];
    if (
      Math.abs(targetWall.x - player.x) + Math.abs(targetWall.y - player.y) ===
      1
    ) {
      console.log("🧱 Chest blocking path. Considering bombing.");
      const futureBombs = [
        ...bombs,
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
      if (futureSafeTiles.length > 0) {
        // Use the safe pathfinder for escaping the planned bomb
        const escapePath = findBestPath(
          map,
          player,
          futureSafeTiles,
          futureBombs,
          bombers,
          myBomber
        );

        console.log("escapePath:", escapePath);
        if (escapePath && escapePath.path.length > 0) {
          if (myBomber.bombCount) {
            return { action: "BOMB", escapeAction: escapePath.path[0] };
          }
        }
      }
      return { action: "STAY" }; // Not safe to bomb
    }
  }
  // Move towards target or the blocking chest
  if (result.path.length > 0) {
    return { action: result.path[0] };
  }
  return { action: "STAY" };
}

/* ================================
   2️⃣ Core Decision Logic
   ================================ */

export function decideNextAction(state, myUid) {
  const { map, bombs = [], bombers } = state;
  const myBomber = bombers?.find((b) => b.uid === myUid);

  if (!myBomber || !myBomber.isAlive) {
    console.warn("⚠️ No active bomber found for UID:", myUid);
    return { action: "STAY" };
  }

  // convert to grid coordinate
  const player = {
    x: Math.floor(myBomber.x / 40),
    y: Math.floor(myBomber.y / 40),
  };

  // 🚨 High-priority: Escape from bomb blasts
  const safeTiles = findSafeTiles(map, bombs, bombers, myBomber);
  const isPlayerSafe = bombs.length
    ? safeTiles.some((tile) => tile.x === player.x && tile.y === player.y)
    : true;

  if (!isPlayerSafe) {
    console.log(
      `🚨 Unsafe at [${player.x}, ${player.y}]! Finding escape route...`
    );
    if (safeTiles.length) {
      // Try to find a safe tile that isn't luring us back into a loop.
      const smarterSafeTiles = safeTiles.filter((safe) => {
        return !recentlyBombed.some(
          (bombed) =>
            Math.abs(safe.x - bombed.x) + Math.abs(safe.y - bombed.y) <= 1
        );
      });

      const targetSafeTiles =
        smarterSafeTiles.length > 0 ? smarterSafeTiles : safeTiles;

      // Find the nearest safe tile to escape to, using a path that is itself safe and clear of breakable walls.
      const escapePath = findBestPath(
        map,
        player,
        targetSafeTiles,
        bombs,
        bombers,
        myBomber,
        true // isEscaping = true
      );
      if (escapePath && escapePath.path.length) {
        console.log(`Found safe escape path. Moving ${escapePath.path[0]}`);
        return { action: escapePath.path[0] };
      }
    }
    // No escape route, brace for impact
    console.log("⚠️ No safe escape path found! Bracing for impact.");
    return { action: "STAY" };
  }

  // Strategy:
  // 1. Find paths to both nearest item and nearest chest.
  // 2. Compare path lengths and choose the better target.
  // 3. If a chest blocks the path, bomb it.
  // 4. If at a tile adjacent to a target chest, bomb it.
  // 5. If no targets, explore.

  // 1️⃣ Find path to nearest item (that is not in a danger zone)
  const items = findAllItems(map, bombs, bombers, myBomber);
  const itemResult = items.length
    ? findBestPath(map, player, items, bombs, bombers, myBomber)
    : null;

  // 2️⃣ Find path to nearest chest (that is not in a danger zone)
  const chests = findAllChests(map, bombs, bombers, myBomber);
  let chestResult = null;
  if (chests.length) {
    // Are we already next to a chest? If so, that's our primary chest action.
    const adjacentChest = chests.find((c) => {
      const dx = Math.abs(c.x - player.x);
      const dy = Math.abs(c.y - player.y);
      if ((dx === 1 && dy === 0) || (dx === 0 && dy === 1)) {
        console.log("===============================================");
        console.log("c, player:", c, player);
        console.log("===============================================");
      }
      return (dx === 1 && dy === 0) || (dx === 0 && dy === 1);
    });
    if (adjacentChest) {
      console.log("🧱 Adjacent to a chest. Considering bombing.");
      if (myBomber.bombCount) {
        // Add to memory before deciding to bomb
        recentlyBombed.push({ x: adjacentChest.x, y: adjacentChest.y });
        if (recentlyBombed.length > RECENT_BOMB_MEMORY) {
          recentlyBombed.shift(); // Keep memory size limited
        }

        const futureBombs = [
          ...bombs,
          {
            x: player.x * 40,
            y: player.y * 40,
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
        if (futureSafeTiles.length > 0) {
          const escapePath = findBestPath(
            map,
            player,
            futureSafeTiles,
            futureBombs,
            bombers,
            myBomber
          );
          console.log("escapePath:", escapePath);

          if (escapePath && escapePath.path.length > 0) {
            console.log("💣 Bomb placed to destroy chest!");
            if (myBomber.bombCount) {
              return { action: "BOMB", escapeAction: escapePath.path[0] };
            }
          }
        }
      }

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
    if (adjacentTargets.length) {
      chestResult = findBestPath(
        map,
        player,
        adjacentTargets,
        bombs,
        bombers,
        myBomber
      );
    }
  }

  // 3️⃣ Compare targets and decide
  let chosenResult = null;
  if (itemResult && chestResult) {
    if (
      itemResult.path.length <=
      chestResult.path.length + ITEM_PRIORITY_BIAS
    ) {
      console.log("🎯 Prioritizing item over chest.");
      chosenResult = itemResult;
    } else {
      console.log("🎯 Prioritizing chest over item.");
      chosenResult = chestResult;
    }
  } else if (itemResult) {
    console.log("🎯 Only item found.");
    chosenResult = itemResult;
  } else if (chestResult) {
    console.log("🎯 Only chest found.");
    chosenResult = chestResult;
  }

  // 4️⃣ Execute action for the chosen target
  if (chosenResult) {
    return handleTarget(chosenResult, state, myUid);
  }

  // 5️⃣ No targets found, explore
  if (safeTiles.length > 0) {
    const explorePath = findBestPath(
      map,
      player,
      safeTiles,
      bombs,
      bombers,
      myBomber
    );
    if (explorePath && explorePath.path.length > 0) {
      console.log("No targets found. Exploring...");
      return { action: explorePath.path[0] };
    }
  }

  return { action: "STAY" };
}
