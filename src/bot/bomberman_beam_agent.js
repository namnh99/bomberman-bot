import {
  GRID_SIZE,
  DIRS,
  WALKABLE,
  BREAKABLE,
  BLOCKABLE_EXPLOSION,
  ITEM_VALUES,
  ITEM_PRIORITY_BIAS,
  BOMB_EXPLOSION_TIME,
  STEP_DELAY,
} from "../constants/index.js"

// Anti-oscillation: Track last position and decision to prevent immediate backtracking
let lastPosition = null
let lastDecision = null
let decisionCount = 0

// Helper to track decisions
function trackDecision(player, action) {
  const posKey = `${player.x},${player.y}`
  lastPosition = posKey
  lastDecision = action
}

/**
 * Helper function to get a set of all coordinates currently in an explosion radius.
 * Exported for use in escape path validation.
 */
export function findUnsafeTiles(map, bombs = [], allBombers = []) {
  const unsafeCoords = new Set()
  const h = map.length
  const w = map[0].length

  for (const bomb of bombs) {
    if (bomb.isExploded) continue

    const owner = allBombers.find((b) => b.uid === bomb.uid)
    const range = owner ? owner.explosionRange : 2

    const gridBombX = Math.floor(bomb.x / GRID_SIZE)
    const gridBombY = Math.floor(bomb.y / GRID_SIZE)

    unsafeCoords.add(`${gridBombX},${gridBombY}`)
    for (const [dx, dy] of DIRS) {
      for (let step = 1; step <= range; step++) {
        const nx = gridBombX + dx * step
        const ny = gridBombY + dy * step
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) break
        if (BLOCKABLE_EXPLOSION.includes(map[ny][nx])) break
        unsafeCoords.add(`${nx},${ny}`)
      }
    }
  }
  return unsafeCoords
}

/**
 * Check if a tile will be safe by the time we reach it (considering bomb timers)
 * @param {number} x - Grid X coordinate
 * @param {number} y - Grid Y coordinate
 * @param {number} stepsToReach - Number of steps to reach this tile
 * @param {Array} bombs - Array of active bombs
 * @param {Array} allBombers - Array of all bombers
 * @param {Object} map - Game map
 * @param {number} currentSpeed - Current movement speed (pixels per tick)
 * @returns {boolean} - True if tile will be safe when we reach it
 */
function isTileSafeByTime(x, y, stepsToReach, bombs, allBombers, map, currentSpeed = 1) {
  const now = Date.now()
  // Calculate time to reach this tile (steps * GRID_SIZE / speed * STEP_DELAY)
  const timeToReach = ((stepsToReach * GRID_SIZE) / currentSpeed) * STEP_DELAY

  const h = map.length
  const w = map[0].length

  // Check each bomb to see if it will explode before we reach this tile
  for (const bomb of bombs) {
    if (bomb.isExploded) continue

    const owner = allBombers.find((b) => b.uid === bomb.uid)
    const range = owner ? owner.explosionRange : 2

    const gridBombX = Math.floor(bomb.x / GRID_SIZE)
    const gridBombY = Math.floor(bomb.y / GRID_SIZE)

    // Calculate when this bomb will explode using server's lifeTime
    const bombCreatedAt = bomb.createdAt || now // Server provides this
    const bombLifeTime = bomb.lifeTime || BOMB_EXPLOSION_TIME // Server's lifeTime in ms, fallback to constant
    const timeUntilExplosion = bombLifeTime - (now - bombCreatedAt)

    // Check if tile IS the bomb location
    if (x === gridBombX && y === gridBombY) {
      // Only allow crossing the bomb tile if we can pass BEFORE it explodes
      if (timeUntilExplosion > 0 && timeToReach < timeUntilExplosion) {
        // We can pass through before explosion - continue checking other bombs
        continue
      } else {
        // Bomb will explode while we're on it - UNSAFE
        return false
      }
    }

    // Check if tile is in explosion range
    let isInBlastZone = false
    for (const [dx, dy] of DIRS) {
      for (let step = 1; step <= range; step++) {
        const nx = gridBombX + dx * step
        const ny = gridBombY + dy * step
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) break
        if (BLOCKABLE_EXPLOSION.includes(map[ny][nx])) break
        if (nx === x && ny === y) {
          isInBlastZone = true
          break
        }
      }
      if (isInBlastZone) break
    }

    // If tile is in blast zone, check timing
    if (isInBlastZone) {
      // If bomb will explode before or when we reach this tile, it's UNSAFE
      if (timeUntilExplosion <= 0 || timeToReach >= timeUntilExplosion) {
        return false // Tile will be in blast zone when bomb explodes
      }
      // Else: we reach before explosion, but we're in blast zone
      // This is only safe if it's a waypoint we pass through quickly
      // For now, consider it UNSAFE as a destination
      return false
    }
  }

  return true // Tile is safe from all bombs considering timing
}

/**
 * Find safe empty tiles (not inside explosion radius)
 */
function findSafeTiles(map, bombs = [], allBombers = []) {
  const safeTiles = []
  const h = map.length
  const w = map[0].length
  const unsafeTiles = findUnsafeTiles(map, bombs, allBombers)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (map[y][x] === null && !unsafeTiles.has(`${x},${y}`)) {
        safeTiles.push({ x, y })
      }
    }
  }

  return safeTiles
}

/* ================================
   1️⃣ Utility Functions
   ================================ */

function findAllItems(map, bombs, allBombers) {
  const items = []
  const unsafeTiles = findUnsafeTiles(map, bombs, allBombers)
  for (let y = 0; y < map.length; y++) {
    for (let x = 0; x < map[y].length; x++) {
      const cell = map[y][x]
      // Ignore items in a blast zone
      if (["B", "R", "S"].includes(cell) && !unsafeTiles.has(`${x},${y}`)) {
        items.push({ x, y, type: cell, value: ITEM_VALUES[cell] || 1 })
      }
    }
  }
  return items
}

function findAllChests(map, bombs, allBombers) {
  const targets = []
  const unsafeTiles = findUnsafeTiles(map, bombs, allBombers)
  for (let y = 0; y < map.length; y++) {
    for (let x = 0; x < map[y].length; x++) {
      // Ignore chests in a blast zone
      if (map[y][x] === "C" && !unsafeTiles.has(`${x},${y}`)) {
        targets.push({ x, y })
      }
    }
  }
  return targets
}

/**
 * Find enemy bombers (alive, not me) and return their grid positions
 */
function findAllEnemies(map, bombs, allBombers, myUid) {
  const enemies = []
  for (const b of allBombers) {
    if (!b.isAlive) continue
    if (b.uid === myUid) continue
    const ex = Math.floor(b.x / GRID_SIZE)
    const ey = Math.floor(b.y / GRID_SIZE)
    enemies.push({ x: ex, y: ey, bomber: b })
  }
  return enemies
}

/**
 * A unified BFS that finds the best path to a target, avoiding active bomb zones
 * and keeping track of breakable chests in the way.
 */
function findBestPath(map, start, targets, bombs, allBombers, myUid, isEscaping = false) {
  const h = map.length
  const w = map[0].length
  const queue = [[start.x, start.y, [], []]] // [x, y, path, walls]
  const visited = new Set([`${start.x},${start.y}`])

  // Pre-calculate unsafe tiles for O(1) lookup and better performance
  const unsafeTiles = findUnsafeTiles(map, bombs, allBombers)

  // ALL bombs block movement, EXCEPT:
  // - Bombs where bomberPassedThrough is false (bomber still on the bomb, can walk off)
  const activeBombs = bombs.filter((b) => !b.isExploded)
  const bombTiles = new Map() // Map of "x,y" -> bomb object
  activeBombs.forEach((b) => {
    const key = `${Math.floor(b.x / GRID_SIZE)},${Math.floor(b.y / GRID_SIZE)}`
    bombTiles.set(key, b)
  })

  while (queue.length) {
    const [x, y, path, walls] = queue.shift()

    if (
      targets.some((t) => {
        if (isEscaping) return t.x === x && t.y === y && !unsafeTiles.has(`${t.x},${t.y}`)
        return t.x === x && t.y === y
      })
    ) {
      return { path, walls }
    }

    for (const [dx, dy, dir] of DIRS) {
      const nx = x + dx
      const ny = y + dy
      const key = `${nx},${ny}`

      if (nx < 0 || ny < 0 || nx >= w || ny >= h || visited.has(key)) {
        continue
      }

      // CRITICAL FIX: When not escaping, NEVER enter bomb zones
      // This prevents the bot from walking back into danger after escaping
      if (!isEscaping && unsafeTiles.has(key)) {
        console.log(`   ⚠️  Avoiding bomb zone at [${nx}, ${ny}] while pathfinding`)
        continue
      }

      // Block bomb tiles based on bomberPassedThrough flag
      const bombAtTile = bombTiles.get(key)
      if (bombAtTile) {
        // If bomberPassedThrough === true -> bomb blocks (we already left it)
        // If bomberPassedThrough === false -> we can walk through (still on it or bomb placed elsewhere)
        if (bombAtTile.bomberPassedThrough) {
          // console.log(`   ⛔ Blocking bomb at [${nx}, ${ny}] (already passed through)`)
          continue
        }
        // else: can walk on it (we're still on the bomb tile)
      }

      // When escaping, only prevent going from safe to unsafe
      // (allow moving through unsafe zones to reach safety)
      if (isEscaping) {
        const isCurrentTileSafe = !unsafeTiles.has(`${x},${y}`)
        if (isCurrentTileSafe && unsafeTiles.has(key)) {
          continue
        }
      }

      const cell = map[ny][nx]
      if (WALKABLE.includes(cell)) {
        visited.add(key)
        const newPath = [...path, dir]
        const newWalls = BREAKABLE.includes(cell) ? [...walls, { x: nx, y: ny }] : walls
        queue.push([nx, ny, newPath, newWalls])
      }
    }
  }

  return null // No path found
}

/**
 * Find the FASTEST path to the nearest safe tile using optimized BFS
 * Returns immediately when first safe tile is found (guaranteed shortest)
 * Now considers bomb explosion times - allows crossing danger zones if we can reach safety in time
 */
function findShortestEscapePath(map, start, bombs, allBombers, myBomber) {
  const h = map.length
  const w = map[0].length
  const currentSpeed = myBomber.speed || 1

  // ALL bombs block movement, EXCEPT ones where bomberPassedThrough is false
  const activeBombs = bombs.filter((b) => !b.isExploded)
  const bombTiles = new Map() // Map of "x,y" -> bomb object
  activeBombs.forEach((b) => {
    const key = `${Math.floor(b.x / GRID_SIZE)},${Math.floor(b.y / GRID_SIZE)}`
    bombTiles.set(key, b)
  })

  // BFS queue: [x, y, path, stepCount]
  const queue = [[start.x, start.y, [], 0]]
  const visited = new Set([`${start.x},${start.y}`])

  while (queue.length) {
    const [x, y, path, stepCount] = queue.shift()

    // Check if we're currently on a bomb tile
    const key = `${x},${y}`
    const bombAtCurrentTile = bombTiles.get(key)

    // Check if current position will be safe considering bomb timers
    const willBeSafe = isTileSafeByTime(x, y, stepCount, activeBombs, allBombers, map, currentSpeed)

    // If this tile will be safe when we reach it
    if (willBeSafe) {
      // Only consider it a valid escape destination if it's NOT a bomb tile
      if (!bombAtCurrentTile && path.length > 0) {
        console.log(
          `   🕐 Found time-safe escape to [${x}, ${y}] in ${stepCount} steps (${(((stepCount * GRID_SIZE) / currentSpeed) * STEP_DELAY).toFixed(0)}ms)`,
        )
        return { path, target: { x, y }, distance: path.length }
      }
      // If it's a bomb tile, we can pass through it but not stop here
      // Continue BFS to find a safe non-bomb destination
    } else if (path.length === 0) {
      // Already safe at start (shouldn't happen in escape scenario)
      return null
    } else {
      // This tile is unsafe - don't explore further from here
      continue
    }

    // Explore all 4 directions
    for (const [dx, dy, dir] of DIRS) {
      const nx = x + dx
      const ny = y + dy
      const key = `${nx},${ny}`

      // Bounds check and visited check
      if (nx < 0 || ny < 0 || nx >= w || ny >= h || visited.has(key)) {
        continue
      }

      const cell = map[ny][nx]

      // During escape, we DON'T block bomb tiles - we can cross them if timing allows
      // The isTileSafeByTime() check above already ensures we won't be on the bomb when it explodes

      // Only walk through empty spaces and items (not walls or chests)
      if (WALKABLE.includes(cell)) {
        visited.add(key)
        queue.push([nx, ny, [...path, dir], stepCount + 1])
      }
    }
  }

  return null // No escape route found
}

function handleTarget(result, state, myUid) {
  const { map, bombs = [], bombers } = state
  // Filter out exploded bombs
  const activeBombs = bombs.filter((b) => !b.isExploded)

  const myBomber = bombers && bombers.find((b) => b.uid === myUid)
  const player = {
    x: Math.floor(myBomber.x / 40),
    y: Math.floor(myBomber.y / 40),
  }

  console.log(`   Path: ${result.path.join(" → ")} (${result.path.length} steps)`)
  console.log(`   Walls blocking: ${result.walls.length}`)

  // If path is blocked by a chest, handle it
  if (result.walls.length > 0) {
    const targetWall = result.walls[0]
    console.log(`   First blocking wall at: [${targetWall.x}, ${targetWall.y}]`)

    if (Math.abs(targetWall.x - player.x) + Math.abs(targetWall.y - player.y) === 1) {
      console.log("   🧱 Chest is adjacent! Considering bombing...")

      const futureBombs = [
        ...activeBombs,
        {
          x: player.x * 40,
          y: player.y * 40,
          explosionRange: myBomber.explosionRange,
        },
      ]
      const futureSafeTiles = findSafeTiles(state.map, futureBombs, bombers, myBomber)
      console.log(`   Future safe tiles: ${futureSafeTiles.length}`)

      if (futureSafeTiles.length > 0) {
        // Use the safe pathfinder for escaping the planned bomb
        const escapePath = findBestPath(
          map,
          player,
          futureSafeTiles,
          futureBombs,
          bombers,
          myUid,
          true, // isEscaping = true (can cross danger to reach safety)
        )

        if (escapePath && escapePath.path.length > 0) {
          console.log(`   ✅ Escape path: ${escapePath.path.join(" → ")}`)
          console.log("🎯 DECISION: BOMB + ESCAPE (blocking chest)")
          console.log("   💣 Bombing wall at", `[${targetWall.x}, ${targetWall.y}]`)
          console.log("   🏃 Escape action:", escapePath.path[0])
          console.log("=".repeat(60) + "\n")

          if (myBomber.bombCount) {
            return {
              action: "BOMB",
              escapeAction: escapePath.path[0],
              isEscape: true,
              fullPath: escapePath.path,
            }
          }
        } else {
          console.log(`   ❌ No escape path found`)
        }
      } else {
        console.log(`   ❌ No safe tiles after bombing`)
      }
    } else {
      console.log(`   Wall not adjacent, need to move closer first`)
    }
    console.log("🎯 DECISION: STAY (Not safe to bomb blocking chest)")
    console.log("=".repeat(60) + "\n")
    return { action: "STAY" } // Not safe to bomb
  }

  // Move towards target or the blocking chest
  if (result.path.length > 0) {
    console.log("🎯 DECISION: MOVE (towards target)")
    console.log("   Action:", result.path[0])
    console.log("=".repeat(60) + "\n")
    trackDecision(player, result.path[0]) // Track decision
    return { action: result.path[0] }
  }

  console.log("🎯 DECISION: STAY (No path)")
  console.log("=".repeat(60) + "\n")
  trackDecision(player, "STAY") // Track decision
  return { action: "STAY" }
}

/* ================================
   2️⃣ Core Decision Logic
   ================================ */

export function decideNextAction(state, myUid) {
  const { map, bombs = [], bombers } = state
  const myBomber = bombers && bombers.find((b) => b.uid === myUid)

  // console.log("\n" + "=".repeat(90));
  // console.log("🤖 BOT DECISION CYCLE STARTED");
  // console.log("=".repeat(90));

  if (!myBomber || !myBomber.isAlive) {
    console.warn("⚠️ No active bomber found for UID:", myUid)
    return { action: "STAY" }
  }

  // convert to grid coordinate
  const player = {
    x: Math.floor(myBomber.x / GRID_SIZE),
    y: Math.floor(myBomber.y / GRID_SIZE),
  }

  // Anti-oscillation check: Detect if we're bouncing between same positions
  const currentPosKey = `${player.x},${player.y}`
  if (lastPosition === currentPosKey && lastDecision) {
    decisionCount++
    if (decisionCount >= 2) {
      // console.log(
      //   `⚠️ OSCILLATION DETECTED! Been at [${player.x}, ${player.y}] ${decisionCount} times`
      // );
      // console.log(`   Last decision was: ${lastDecision}`);
      // console.log(`   🔄 Breaking loop by forcing original decision`);
      // Keep the same decision to commit to the path
      lastPosition = null // Reset after forcing decision
      decisionCount = 0
      return { action: lastDecision }
    }
  } else {
    // Different position or first decision, reset counter
    decisionCount = 0
  }

  // console.log("📍 Player Position:", {
  //   pixel: `[${myBomber.x}, ${myBomber.y}]`,
  //   grid: `[${player.x}, ${player.y}]`,
  //   orient: myBomber.orient,
  // });
  // console.log("📊 Player Stats:", {
  //   bombCount: myBomber.bombCount,
  //   explosionRange: myBomber.explosionRange,
  //   speed: myBomber.speed,
  //   isAlive: myBomber.isAlive,
  // });
  // console.log("💣 Total Bombs in State:", bombs.length);

  // Debug: Show all bombs and their status
  // if (bombs.length > 0) {
  //   console.log("   Bomb Details:");
  //   bombs.forEach((bomb, idx) => {
  //     const gridX = Math.floor(bomb.x / GRID_SIZE);
  //     const gridY = Math.floor(bomb.y / GRID_SIZE);
  //     console.log(
  //       `   Bomb ${idx + 1}: [${gridX}, ${gridY}] | isExploded: ${
  //         bomb.isExploded || false
  //       } | uid: ${bomb.uid || "N/A"}`
  //     );
  //   });
  // }

  // Filter out exploded bombs
  const activeBombs = bombs.filter((b) => !b.isExploded)
  console.log("💣 Active (non-exploded) Bombs:", activeBombs.length)
  if (activeBombs.length > 0) {
    console.log("   Bomb positions:")
    activeBombs.forEach((b, i) => {
      const gridX = Math.floor(b.x / GRID_SIZE)
      const gridY = Math.floor(b.y / GRID_SIZE)
      console.log(
        `   Bomb ${i + 1}: [${gridX}, ${gridY}] | owner: ${b.uid === myUid ? "ME" : b.uid}`,
      )
    })
  }
  console.log("👥 Active Bombers:", bombers.filter((b) => b.isAlive).length)

  // 🚨 High-priority: Escape from bomb blasts
  console.log("\n🔍 PHASE 1: Safety Check")
  const safeTiles = findSafeTiles(map, activeBombs, bombers, myBomber)
  const isPlayerSafe = activeBombs.length
    ? safeTiles.some((tile) => tile.x === player.x && tile.y === player.y)
    : true

  console.log(`   Safety Status: ${isPlayerSafe ? "✅ SAFE" : "🚨 DANGER"}`)
  console.log(`   Safe Tiles Available: ${safeTiles.length}`)

  if (!isPlayerSafe) {
    console.log(`   🚨 UNSAFE at [${player.x}, ${player.y}]! Finding shortest escape route...`)

    // Use BFS to find the SHORTEST path to ANY safe tile
    const escapeResult = findShortestEscapePath(map, player, activeBombs, bombers, myBomber)

    if (escapeResult && escapeResult.path.length > 0) {
      console.log(`   ✅ Shortest escape path found: ${escapeResult.path.join(" → ")}`)
      console.log(`   Target safe tile: [${escapeResult.target.x}, ${escapeResult.target.y}]`)
      console.log(`   Distance: ${escapeResult.distance} steps`)
      console.log("🎯 DECISION: ESCAPE (shortest path to safety)")
      console.log("   Action:", escapeResult.path[0])
      console.log("=".repeat(90) + "\n")
      trackDecision(player, escapeResult.path[0]) // Track escape decision
      return {
        action: escapeResult.path[0],
        isEscape: true,
        fullPath: escapeResult.path, // Return the FULL escape path
      }
    }

    // No escape route found, try to move to any adjacent walkable tile
    // Prefer tiles that will be safe considering bomb explosion times
    console.log("   ⚠️ No direct escape path, trying emergency moves...")
    const unsafeTiles = findUnsafeTiles(map, activeBombs, bombers)
    const currentSpeed = myBomber.speed || 1

    // First pass: try to find a walkable tile that will be safe by the time we reach it
    for (const [dx, dy, dir] of DIRS) {
      const nx = player.x + dx
      const ny = player.y + dy
      if (nx >= 0 && ny >= 0 && nx < map[0].length && ny < map.length) {
        const cell = map[ny][nx]
        const key = `${nx},${ny}`

        // Check if this tile is a bomb location
        const isBombTile = activeBombs.some((bomb) => {
          const bombGridX = Math.floor(bomb.x / GRID_SIZE)
          const bombGridY = Math.floor(bomb.y / GRID_SIZE)
          return bombGridX === nx && bombGridY === ny
        })

        // Check if tile will be safe considering bomb timers (1 step away)
        const willBeSafe = isTileSafeByTime(nx, ny, 1, activeBombs, bombers, map, currentSpeed)

        // Only consider it safe if it's NOT a bomb tile AND will be safe
        if (WALKABLE.includes(cell) && willBeSafe && !isBombTile) {
          console.log(`   ✅ Time-safe emergency move: ${dir} to [${nx}, ${ny}]`)
          console.log("🎯 DECISION: EMERGENCY ESCAPE (time-safe tile)")
          console.log("   Action:", dir)
          console.log("=".repeat(90) + "\n")
          trackDecision(player, dir)
          return { action: dir }
        }
      }
    }

    // Second pass: try tiles not currently in blast zones (even if bombs will explode soon)
    for (const [dx, dy, dir] of DIRS) {
      const nx = player.x + dx
      const ny = player.y + dy
      if (nx >= 0 && ny >= 0 && nx < map[0].length && ny < map.length) {
        const cell = map[ny][nx]
        const key = `${nx},${ny}`

        // Check if this tile is a bomb location
        const isBombTile = activeBombs.some((bomb) => {
          const bombGridX = Math.floor(bomb.x / GRID_SIZE)
          const bombGridY = Math.floor(bomb.y / GRID_SIZE)
          return bombGridX === nx && bombGridY === ny
        })

        if (WALKABLE.includes(cell) && !unsafeTiles.has(key) && !isBombTile) {
          console.log(
            `   ⚠️ Currently safe emergency move: ${dir} to [${nx}, ${ny}] (but bomb may explode!)`,
          )
          console.log("🎯 DECISION: EMERGENCY ESCAPE (currently safe)")
          console.log("   Action:", dir)
          console.log("=".repeat(90) + "\n")
          trackDecision(player, dir)
          return { action: dir }
        }
      }
    }

    // Third pass: if no safe tiles, just pick any walkable tile (last resort)
    for (const [dx, dy, dir] of DIRS) {
      const nx = player.x + dx
      const ny = player.y + dy
      if (nx >= 0 && ny >= 0 && nx < map[0].length && ny < map.length) {
        const cell = map[ny][nx]

        // Check if this tile is a bomb location
        const isBombTile = activeBombs.some((bomb) => {
          const bombGridX = Math.floor(bomb.x / GRID_SIZE)
          const bombGridY = Math.floor(bomb.y / GRID_SIZE)
          return bombGridX === nx && bombGridY === ny
        })

        if (WALKABLE.includes(cell) && !isBombTile) {
          console.log(`   ⚠️ Last resort move: ${dir} to [${nx}, ${ny}] (still in danger!)`)
          console.log("🎯 DECISION: EMERGENCY ESCAPE (desperate)")
          console.log("   Action:", dir)
          console.log("=".repeat(90) + "\n")
          trackDecision(player, dir)
          return { action: dir }
        }
      }
    }

    // Absolutely no escape route, brace for impact
    console.log("   ❌ No escape possible! Bracing for impact.")
    console.log("🎯 DECISION: STAY (No escape)")
    console.log("=".repeat(90) + "\n")
    trackDecision(player, "STAY") // Track stay decision
    return { action: "STAY" }
  }

  // Strategy:
  // 1. Find paths to both nearest item and nearest chest.
  // 2. Compare path lengths and choose the better target.
  // 3. If a chest blocks the path, bomb it.
  // 4. If at a tile adjacent to a target chest, bomb it.
  // 5. If no targets, explore.

  // console.log("\n🔍 PHASE 2: Target Analysis");

  // 1️⃣ Find path to nearest item (that is not in a danger zone)
  const items = findAllItems(map, activeBombs, bombers)
  console.log(`   Items found: ${items.length}`)
  if (items.length > 0) {
    console.log(
      `   Item locations:`,
      items
        .slice(0, 3)
        .map((i) => `[${i.x},${i.y}] (${i.type})`)
        .join(", "),
    )
  }

  const itemResult = items.length
    ? findBestPath(map, player, items, activeBombs, bombers, myUid)
    : null

  if (itemResult) {
    console.log(
      `   ✅ Path to item: ${itemResult.path.join(" → ")} (${itemResult.path.length} steps)`,
    )
  } else if (items.length > 0) {
    console.log(`   ❌ No path to items found`)
  }

  // 2️⃣ Find path to nearest chest (that is not in a danger zone)
  const chests = findAllChests(map, activeBombs, bombers)
  console.log(`   Chests found: ${chests.length}`)
  if (chests.length > 0) {
    console.log(
      `   Chest locations:`,
      chests
        .slice(0, 3)
        .map((c) => `[${c.x},${c.y}]`)
        .join(", "),
    )
  }

  let chestResult = null
  if (chests.length) {
    // Are we already next to a chest? If so, that's our primary chest action.
    const adjacentChest = chests.find((c) => {
      const dx = Math.abs(c.x - player.x)
      const dy = Math.abs(c.y - player.y)
      return (dx === 1 && dy === 0) || (dx === 0 && dy === 1)
    })
    if (adjacentChest) {
      console.log(`\n🔍 PHASE 3: Adjacent Chest Bombing`)
      console.log(`   🧱 Adjacent chest at [${adjacentChest.x}, ${adjacentChest.y}]`)

      // Check if there's already a bomb at our current position
      const bombAlreadyHere = activeBombs.some((bomb) => {
        const bombGridX = Math.floor(bomb.x / GRID_SIZE)
        const bombGridY = Math.floor(bomb.y / GRID_SIZE)
        return bombGridX === player.x && bombGridY === player.y
      })

      if (bombAlreadyHere) {
        console.log(`   ⏸️  Bomb already exists at [${player.x}, ${player.y}], escaping instead`)
        // Find escape path from existing bomb
        const safeTiles = findSafeTiles(map, activeBombs, bombers, myBomber)
        if (safeTiles.length > 0) {
          const escapePath = findBestPath(map, player, safeTiles, activeBombs, bombers, myUid, true)
          if (escapePath && escapePath.path.length > 0) {
            return {
              action: escapePath.path[0],
              isEscape: true,
              fullPath: escapePath.path,
            }
          }
        }
        return { action: "STAY" }
      }

      if (myBomber.bombCount) {
        const futureBombs = [
          ...activeBombs,
          {
            x: player.x * GRID_SIZE,
            y: player.y * GRID_SIZE,
            explosionRange: myBomber.explosionRange,
            uid: myBomber.uid,
          },
        ]
        // Find an escape path from our planned bomb
        const futureSafeTiles = findSafeTiles(map, futureBombs, bombers, myBomber)
        console.log(`   Future safe tiles after bombing: ${futureSafeTiles.length}`)

        if (futureSafeTiles.length > 0) {
          const escapePath = findBestPath(
            map,
            player,
            futureSafeTiles,
            futureBombs,
            bombers,
            myUid,
            true, // isEscaping = true (can cross danger to reach safety)
          )

          if (escapePath && escapePath.path.length > 0) {
            console.log(`   ✅ Escape path found: ${escapePath.path.join(" → ")}`)
            console.log("🎯 DECISION: BOMB + ESCAPE")
            console.log("   💣 Bombing chest at", `[${adjacentChest.x}, ${adjacentChest.y}]`)
            console.log("   🏃 Escape action:", escapePath.path[0])
            console.log("=".repeat(90) + "\n")

            return {
              action: "BOMB",
              isEscape: true,
              escapeAction: escapePath.path[0],
              fullPath: escapePath.path,
            }
          } else {
            console.log(`   ❌ No escape path found after bombing`)
          }
        } else {
          console.log(`   ❌ No safe tiles after bombing`)
        }
      } else {
        console.log(`   ❌ No bombs available`)
      }

      console.log("🎯 DECISION: STAY (Not safe to bomb)")
      console.log("=".repeat(90) + "\n")
      return { action: "STAY" } // Not safe to bomb or no bombs left
    }

    // Find walkable tiles adjacent to any chest
    const adjacentTargets = []
    for (const chest of chests) {
      for (const [dx, dy] of DIRS) {
        const adjX = chest.x + dx
        const adjY = chest.y + dy
        if (map[adjY] && WALKABLE.includes(map[adjY][adjX])) {
          // Skip tiles that currently have an active bomb to avoid blocking ourselves
          const hasBomb = activeBombs.some((b) => {
            return Math.floor(b.x / GRID_SIZE) === adjX && Math.floor(b.y / GRID_SIZE) === adjY
          })
          if (hasBomb) {
            console.log(
              `   ⛔ Skipping adjacent target [${adjX},${adjY}] because it has an active bomb`,
            )
          } else {
            adjacentTargets.push({ x: adjX, y: adjY })
          }
        }
      }
    }
    console.log(`   Adjacent chest targets: ${adjacentTargets.length}`)

    if (adjacentTargets.length) {
      chestResult = findBestPath(map, player, adjacentTargets, activeBombs, bombers, myUid)
      if (chestResult) {
        console.log(
          `   ✅ Path to chest: ${chestResult.path.join(" → ")} (${chestResult.path.length} steps)`,
        )
      }
    }
  }

  // 3️⃣ Compare targets and decide
  console.log(`\n🔍 PHASE 4: Target Prioritization`)
  let chosenResult = null
  let targetType = null

  if (itemResult && chestResult) {
    console.log(
      `   Comparing: Item(${itemResult.path.length}) vs Chest(${chestResult.path.length}) + Bias(${ITEM_PRIORITY_BIAS})`,
    )
    if (itemResult.path.length <= chestResult.path.length + ITEM_PRIORITY_BIAS) {
      console.log("   ✅ Prioritizing ITEM over chest")
      chosenResult = itemResult
      targetType = "ITEM"
    } else {
      console.log("   ✅ Prioritizing CHEST over item")
      chosenResult = chestResult
      targetType = "CHEST"
    }
  } else if (itemResult) {
    console.log("   ✅ Only ITEM found")
    chosenResult = itemResult
    targetType = "ITEM"
  } else if (chestResult) {
    console.log("   ✅ Only CHEST found")
    chosenResult = chestResult
    targetType = "CHEST"
  } else {
    console.log("   ❌ No items or chests found")
  }

  // 4️⃣ Execute action for the chosen target
  if (chosenResult) {
    console.log(`\n🔍 PHASE 5: Target Execution (${targetType})`)
    return handleTarget(chosenResult, state, myUid)
  }

  // 5️⃣ No targets found, explore
  console.log(`\n🔍 PHASE 6: Exploration Mode`)
  console.log(`   Safe exploration tiles: ${safeTiles.length}`)

  // -------------------------------
  // Enemy pursuit / kill logic
  // If an enemy bomber is reachable and we can bomb them (and escape), prioritize that
  // -------------------------------
  console.log(`\n🔍 PHASE 5.5: Enemy Pursuit`) // numbering keeps log order readable
  const enemies = findAllEnemies(map, activeBombs, bombers, myUid)
  console.log(`   Enemies found: ${enemies.length}`)

  // Helper: check if a bomb placed at (bx,by) will hit enemy at (ex,ey)
  function willBombHitEnemy(bx, by, ex, ey, map, range) {
    if (bx === ex && by === ey) return true
    // check four directions
    for (const [dx, dy] of DIRS) {
      for (let step = 1; step <= range; step++) {
        const nx = bx + dx * step
        const ny = by + dy * step
        if (nx < 0 || ny < 0 || ny >= map.length || nx >= map[0].length) break
        if (BLOCKABLE_EXPLOSION.includes(map[ny][nx])) break
        if (nx === ex && ny === ey) return true
      }
    }
    return false
  }

  if (enemies.length > 0) {
    for (const enemy of enemies) {
      // If enemy is adjacent to us right now, consider immediate bomb
      const dx = Math.abs(enemy.x - player.x)
      const dy = Math.abs(enemy.y - player.y)

      // If enemy adjacent and we have a bomb, evaluate bombing now
      if ((dx === 1 && dy === 0) || (dx === 0 && dy === 1)) {
        console.log(`   Enemy adjacent at [${enemy.x},${enemy.y}]`) 
        if (myBomber.bombCount) {
          // Will our bomb (placed at our current tile) reach enemy?
          const willHit = willBombHitEnemy(player.x, player.y, enemy.x, enemy.y, map, myBomber.explosionRange)
          if (willHit) {
            const futureBombs = [
              ...activeBombs,
              {
                x: player.x * GRID_SIZE,
                y: player.y * GRID_SIZE,
                explosionRange: myBomber.explosionRange,
                uid: myBomber.uid,
              },
            ]

            const futureSafeTiles = findSafeTiles(map, futureBombs, bombers, myBomber)
            if (futureSafeTiles.length > 0) {
              const escapePath = findBestPath(map, player, futureSafeTiles, futureBombs, bombers, myUid, true)
              if (escapePath && escapePath.path.length > 0) {
                console.log(`   ✅ Can bomb enemy and escape: bomb + ${escapePath.path.join(' → ')}`)
                return {
                  action: 'BOMB',
                  isEscape: true,
                  escapeAction: escapePath.path[0],
                  fullPath: escapePath.path,
                }
              }
            }
          } else {
            console.log('   ⚠️ Bomb here would not reach enemy')
          }
        } else {
          console.log('   ⚠️ No bombs available to attack')
        }
      }

      // Otherwise, try to path to a walkable tile adjacent to the enemy
      const adjacentTargets = []
      for (const [adx, ady] of DIRS) {
        const tx = enemy.x + adx
        const ty = enemy.y + ady
        if (map[ty] && WALKABLE.includes(map[ty][tx])) {
          // Skip tiles with active bombs
          const hasBomb = activeBombs.some((b) => Math.floor(b.x / GRID_SIZE) === tx && Math.floor(b.y / GRID_SIZE) === ty)
          if (!hasBomb) adjacentTargets.push({ x: tx, y: ty })
        }
      }

      if (adjacentTargets.length > 0) {
        const pathToAdj = findBestPath(map, player, adjacentTargets, activeBombs, bombers, myUid)
        if (pathToAdj && pathToAdj.path.length > 0) {
          // If we can reach adjacent tile AND have a bomb, check that bombing from that tile will hit the enemy and we can escape
          if (myBomber.bombCount) {
            // Simulate placing bomb at the final tile in path (where we'd stand to place)
            const finalPos = (() => {
              // Walk through path to compute final grid pos
              let fx = player.x
              let fy = player.y
              for (const step of pathToAdj.path) {
                if (step === 'LEFT') fx -= 1
                if (step === 'RIGHT') fx += 1
                if (step === 'UP') fy -= 1
                if (step === 'DOWN') fy += 1
              }
              return { x: fx, y: fy }
            })()

            const willHit = willBombHitEnemy(finalPos.x, finalPos.y, enemy.x, enemy.y, map, myBomber.explosionRange)
            if (willHit) {
              const futureBombs = [
                ...activeBombs,
                { x: finalPos.x * GRID_SIZE, y: finalPos.y * GRID_SIZE, explosionRange: myBomber.explosionRange, uid: myBomber.uid },
              ]
              const futureSafeTiles = findSafeTiles(map, futureBombs, bombers, myBomber)
              if (futureSafeTiles.length > 0) {
                const escapePath = findBestPath(map, finalPos, futureSafeTiles, futureBombs, bombers, myUid, true)
                if (escapePath && escapePath.path.length > 0) {
                  console.log(`   ✅ Plan: move to enemy-adjacent tile and BOMB+ESCAPE (path: ${pathToAdj.path.join(' → ')})`)
                  // If we're already next step towards that tile, move
                  if (pathToAdj.path.length > 0) {
                    console.log('   🎯 DECISION: MOVE (towards enemy)')
                    trackDecision(player, pathToAdj.path[0])
                    return { action: pathToAdj.path[0] }
                  }
                }
              }
            }
          } else {
            // No bombs but we can still try to chase
            console.log('   ⚠️ No bombs available, chasing enemy')
            trackDecision(player, pathToAdj.path[0])
            return { action: pathToAdj.path[0] }
          }
        }
      }
    }
  }

  if (safeTiles.length > 0) {
    const explorePath = findBestPath(map, player, safeTiles, activeBombs, bombers, myUid)
    if (explorePath && explorePath.path.length > 0) {
      console.log(`   ✅ Exploration path: ${explorePath.path.join(" → ")}`)
      console.log("🎯 DECISION: EXPLORE")
      console.log("   Action:", explorePath.path[0])
      console.log("=".repeat(90) + "\n")
      trackDecision(player, explorePath.path[0]) // Track explore decision
      return { action: explorePath.path[0] }
    } else {
      console.log(`   ❌ No exploration path found`)
    }
  }

  console.log("🎯 DECISION: STAY (No options)")
  console.log("=".repeat(90) + "\n")
  trackDecision(player, "STAY") // Track final stay decision
  return { action: "STAY" }
}
