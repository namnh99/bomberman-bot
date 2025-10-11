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

/* ================================
   1️⃣ Utility Functions
   ================================ */

function findAllItems(map) {
  const items = [];
  for (let y = 0; y < map.length; y++) {
    for (let x = 0; x < map[y].length; x++) {
      const cell = map[y][x];
      if (["B", "R", "S"].includes(cell)) {
        items.push({ x, y });
      }
    }
  }
  return items;
}

function findAllChests(map) {
  const targets = [];
  for (let y = 0; y < map.length; y++) {
    for (let x = 0; x < map[y].length; x++) {
      if (map[y][x] === "C") targets.push({ x, y });
    }
  }
  return targets;
}

function bfsFindPath(map, start, targets) {
  const h = map.length;
  const w = map[0].length;
  const queue = [[start.x, start.y, []]];
  const visited = new Set([`${start.x},${start.y}`]);

  while (queue.length) {
    const [x, y, path] = queue.shift();
    if (targets.some((t) => t.x === x && t.y === y)) {
      return path;
    }

    for (const [dx, dy, dir] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      const key = `${nx},${ny}`;
      if (
        nx >= 0 &&
        ny >= 0 &&
        nx < w &&
        ny < h &&
        !visited.has(key) &&
        WALKABLE.includes(map[ny][nx])
      ) {
        visited.add(key);
        queue.push([nx, ny, [...path, dir]]);
      }
    }
  }

  return null;
}

function bfsFindSafePath(map, start, targets, bombs, allBombers, myBomber) {
  const h = map.length;
  const w = map[0].length;
  const queue = [[start.x, start.y, []]];
  const visited = new Set([`${start.x},${start.y}`]);

  function inExplosionRadius(x, y) {
    for (const bomb of bombs) {
      if (bomb.isExploded) continue; // Ignore exploded bombs

      let range;
      if (bomb.uid) {
        const owner = allBombers.find((b) => b.uid === bomb.uid);
        range = owner ? owner.explosionRange : 2;
      } else {
        range = bomb.range || myBomber?.explosionRange || 3;
      }

      const gridBombX = Math.floor(bomb.x / 40);
      const gridBombY = Math.floor(bomb.y / 40);

      // Simple check is not enough as walls block explosions.
      // We need to check line-of-sight.
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

  const startInDanger = inExplosionRadius(start.x, start.y);

  // ======================
  // 🚀 BFS find safe tiles
  // ======================
  while (queue.length) {
    const [x, y, path] = queue.shift();

    // Just return when outside explosion radius
    if (!inExplosionRadius(x, y) && (!startInDanger || path.length > 0)) {
      // If has targets (multiple potential safe spots)
      if (!targets?.length || targets.some((t) => t.x === x && t.y === y)) {
        console.log(path);
        return path; // found safe path / to target
      }
    }

    for (const [dx, dy, dir] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      const key = `${nx},${ny}`;

      if (
        nx >= 0 &&
        ny >= 0 &&
        nx < w &&
        ny < h &&
        !visited.has(key) &&
        WALKABLE.includes(map[ny][nx])
      ) {
        visited.add(key);

        // Allow first step to move out of danger zone,
        // but not deeper into explosion zone
        const nextDanger = inExplosionRadius(nx, ny);
        const currentDanger = inExplosionRadius(x, y);
        if (nextDanger && !currentDanger) continue;

        queue.push([nx, ny, [...path, dir]]);
      }
    }
  }

  // Không tìm thấy đường thoát
  return null;
}

/**
 * BFS that also records which breakable walls block the way.
 */
function bfsFindPathWithWalls(map, start, targets) {
  const h = map.length;
  const w = map[0].length;
  const queue = [[start.x, start.y, [], []]]; // [x, y, path, walls]
  const visited = new Set([`${start.x},${start.y}`]);

  while (queue.length) {
    const [x, y, path, walls] = queue.shift();

    if (targets.some((t) => t.x === x && t.y === y)) {
      return { path, walls };
    }

    for (const [dx, dy, dir] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      const key = `${nx},${ny}`;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || visited.has(key)) continue;

      const cell = map[ny][nx];
      if (WALKABLE.includes(cell)) {
        queue.push([nx, ny, [...path, dir], walls]); // Pass walls without modification
        visited.add(key);
      } else if (BREAKABLE.includes(cell)) {
        queue.push([nx, ny, [...path, dir], [...walls, { x: nx, y: ny }]]); // Add to walls
        visited.add(key);
      }
    }
  }

  return null;
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

      let range;
      if (bomb.uid) {
        // This is an existing bomb on the map
        const owner = allBombers.find((b) => b.uid === bomb.uid);
        range = owner ? owner.explosionRange : 2;
      } else {
        // This is a future bomb we are simulating
        range = bomb.range || myBomber?.explosionRange || 3;
      }

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
  const { bombs = [], bombers } = state;
  const myBomber = bombers?.find((b) => b.uid === myUid);
  const player = {
    x: Math.floor(myBomber.x / 40),
    y: Math.floor(myBomber.y / 40),
  };

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
          explosionRange: 2,
        },
      ];
      const futureSafeTiles = findSafeTiles(
        state.map,
        futureBombs,
        bombers,
        myBomber
      );
      if (futureSafeTiles.length > 0) {
        const escapePath = bfsFindPath(state.map, player, futureSafeTiles);
        if (escapePath && escapePath.length > 0) {
          return { action: "BOMB", escapeAction: escapePath[0] };
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
  const isPlayerSafe = safeTiles.some(
    (tile) => tile.x === player.x && tile.y === player.y
  );

  if (!isPlayerSafe) {
    console.log(
      `🚨 Unsafe at [${player.x}, ${player.y}]! Finding escape route...`
    );
    console.log("Safe check nam trong vung bomb no");
    if (safeTiles.length) {
      // Find the nearest safe tile to escape to
      const escapePath = bfsFindSafePath(
        map,
        player,
        safeTiles,
        bombs,
        bombers,
        myBomber
      );

      // console.log("Safe tiles:", safeTiles);
      if (escapePath && escapePath.length) {
        console.log(`Found escape path. Moving ${escapePath[0]}`);
        return { action: escapePath[0] };
      }
    }
    // No escape route, brace for impact
    console.log("⚠️ No escape route found! Bracing for impact.");
    return { action: "STAY" };
  }

  // Strategy:
  // 1. Find paths to both nearest item and nearest chest.
  // 2. Compare path lengths and choose the better target.
  // 3. If a chest blocks the path, bomb it.
  // 4. If at a tile adjacent to a target chest, bomb it.
  // 5. If no targets, explore.

  // 1️⃣ Find path to nearest item
  const items = findAllItems(map);
  const itemResult = items.length
    ? bfsFindPathWithWalls(map, player, items)
    : null;

  // 2️⃣ Find path to nearest chest
  const chests = findAllChests(map);
  let chestResult = null;
  if (chests.length) {
    // Are we already next to a chest? If so, that's our primary chest action.
    const adjacentChest = chests.find(
      (c) => Math.abs(c.x - player.x) + Math.abs(c.y - player.y) === 1
    );
    if (adjacentChest) {
      console.log("🧱 Adjacent to a chest. Considering bombing.");
      const futureBombs = [
        ...bombs,
        {
          x: player.x * 40,
          y: player.y * 40,
          explosionRange: myBomber.explosionRange,
        },
      ];
      const futureSafeTiles = findSafeTiles(
        map,
        futureBombs,
        bombers,
        myBomber
      );
      if (futureSafeTiles.length > 0) {
        const escapePath = bfsFindPath(map, player, futureSafeTiles);
        if (escapePath && escapePath.length > 0) {
          console.log("💣 Bomb placed to destroy chest!");
          return { action: "BOMB", escapeAction: escapePath[0] };
        }
      }
      return { action: "STAY" }; // Not safe to bomb
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
      chestResult = bfsFindPathWithWalls(map, player, adjacentTargets);
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
    const explorePath = bfsFindPath(map, player, safeTiles);
    if (explorePath && explorePath.length > 0) {
      console.log("No targets found. Exploring...");
      return { action: explorePath[0] };
    }
  }

  return { action: "STAY" };
}
