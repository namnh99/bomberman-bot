# Bomberman Bot - Flow Documentation

## Tổng Quan Kiến Trúc

Bot Bomberman này được thiết kế theo kiến trúc module hóa với luồng xử lý rõ ràng từ nhận event → phân tích → quyết định → thực thi.

```
┌─────────────────────────────────────────────────────────────────┐
│                        SOCKET EVENTS                            │
│   (game_state, new_bomb, chest_destroyed, bomber_destroyed)    │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                    GAME CONTEXT UPDATE                          │
│      (currentState, bombTracker, pathModeManager)               │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                   DECISION MAKING (agent.js)                    │
│  Phase 0: Game Context Analysis                                 │
│  Phase 1: Safety Check                                          │
│  Phase 2: Item Prioritization                                   │
│  Phase 3: Chest Bombing                                         │
│  Phase 4: Target Prioritization                                 │
│  Phase 5: Target Execution                                      │
└──────────────────────┬──────────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────────┐
│                   ACTION EXECUTION (index.js)                   │
│  - BOMB: placeBomb() + escape sequence                          │
│  - MOVE: smoothMove() with path following                       │
│  - ESCAPE: Multi-step escape path execution                     │
│  - STAY: Wait and re-evaluate                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 1. INITIALIZATION (index.js)

### 1.1 Khởi Tạo Components

```javascript
// Socket connection
const socket = socketManager.getSocket()

// Game state
const gameContext = {
  currentState: null,        // Latest game state from server
  myUid: null,              // Player's unique ID
  moveIntervalId: null,     // Interval for smooth movement
  alignIntervalId: null,    // Interval for grid alignment
  forceClearIntervals()     // Clear all intervals
}

// State managers
const bombTracker = new BombTracker()           // Track bomb placements
const pathModeManager = new PathModeManager()   // Manage escape/follow modes
const manualControlManager = new ManualControlManager() // Manual control
```

### 1.2 Socket Event Registration

```javascript
registerSocketHandlers(
  socket,
  gameContext,
  pathModeManager,
  bombTracker,
  manualControlManager,
  makeDecision,
  setupManualControlCallback,
)
```

**Các Events Quan Trọng:**

- `game_state`: Cập nhật state mỗi frame → trigger `makeDecision()`
- `new_bomb`: Track bombs mới → cập nhật `bombTracker`
- `chest_destroyed`: Remove chest khỏi targeting
- `bomber_destroyed`: Update enemy count
- `game_over`: Reset state

---

## 2. DECISION MAKING FLOW (agent.js)

### Entry Point: `decideNextAction()`

```javascript
function decideNextAction(gameState, myUid) {
  // Validate input
  // Run through 6 phases
  // Return { action, escapeAction, isEscape, fullPath }
}
```

### Phase 0: Game Context Analysis

**Mục đích**: Xác định chiến lược dựa trên giai đoạn game

```javascript
// Determine game phase
const phase = analyzeGamePhase(itemCount, enemyCount, totalChests, chestsRemaining)
// EARLY: >= 75% chests remain
// MID:   25-75% chests remain
// LATE:  < 25% chests remain

// Risk tolerance
const riskTolerance = calculateRiskTolerance(phase)
// EARLY: 80% (careful)
// MID:   60% (balanced)
// LATE:  40% (aggressive)
```

**Output**: Strategy settings cho các phase sau

---

### Phase 1: Safety Check

**Mục đích**: Kiểm tra an toàn và escape nếu nguy hiểm

#### 1.1 Detect Danger

```javascript
const unsafeTiles = findUnsafeTiles(map, bombs, bombers)
const myPos = toGridCoords(player.x, player.y)
const isInDanger = unsafeTiles.has(posKey(myPos.x, myPos.y))
```

#### 1.2 Multi-Bomb Advanced Escape

Nếu có **nhiều bombs** (≥ 2):

```javascript
const escapeTile = findBestMultiBombEscape(map, myPos, bombs, bombers, myBomber)
```

**Cách hoạt động**:

1. Tính toán safe tiles (tiles ngoài blast zones)
2. Tìm tile gần nhất với timing an toàn
3. Dùng BFS tìm path đến tile đó

#### 1.3 Standard Escape (Single Bomb hoặc Fallback)

```javascript
const escapePath = findShortestEscapePath(
  map,
  player,
  bombs,
  bombers,
  myBomber,
  false, // strictMode
)
```

**Escape Path Validation**:

- ✅ Timing safe (`willBeSafe` check)
- ✅ Outside real bomb blast zones (cho phép qua future bomb zones)
- ✅ Has valid exit (không bị trap bởi walls/chests/bombs)

**Anti-Deadlock Logic**:

```javascript
// Nếu KHÔNG có future bombs (tất cả đều real bombs)
// → Allow escape through blast zones (chỉ dựa vào timing)
const isOutsideBlastZones =
  !unsafeTilesFromRealBombs.has(key) || path.length === 0 || !hasFutureBombs
```

#### 1.4 Timing-Optimized Fallback

Nếu path-based escape fail:

```javascript
const prioritizedDirection = findPrioritizedEscapeDirection(myPos, bombs, map, myBomber, bombers)
```

**Cách hoạt động**:

1. Tính time margin cho mỗi direction
2. Sắp xếp theo margin (cao nhất = an toàn nhất)
3. Chọn direction với margin > 0

---

### Phase 2: Item Prioritization

**Mục đích**: Tìm và đánh giá items (speed, power, flame)

```javascript
const items = gameState.items || []
const sortedItems = prioritizeTargets(items, myPos, map, bombs, bombers, myBomber, {
  type: "ITEM",
  riskTolerance,
  gamePhase,
})
```

**Scoring Formula**:

```javascript
score = baseScore * phaseMultiplier * proximityBonus - distancePenalty - riskPenalty
```

**Path Validation**:

- Dùng `findBestPath()` với timing validation
- Check intermediate tiles safe
- Verify destination reachable

---

### Phase 3: Chest Bombing

#### 3.1 Adjacent Chest Bombing

**Priority cao nhất** - bomb ngay nếu có chest cạnh bên:

```javascript
// Check 4 directions
for (const [dx, dy, dir] of [
  [-1, 0, "LEFT"],
  [1, 0, "RIGHT"],
  [0, -1, "UP"],
  [0, 1, "DOWN"],
]) {
  const adjX = gridX + dx
  const adjY = gridY + dy
  if (map[adjY][adjX] === "C") {
    // Found adjacent chest!
  }
}
```

**Proximity Safety Check**:

```javascript
const nearbyDangerousBombs = bombs.filter((b) => {
  const distance = Math.abs(b.gridX - gridX) + Math.abs(b.gridY - gridY)
  const timeRemaining = b.lifeTime - timeSincePlaced
  return distance <= DANGER_PROXIMITY && timeRemaining < 3000
})

if (nearbyDangerousBombs.length > 0) {
  // TOO RISKY - skip bombing
}
```

**Escape Validation** (CRITICAL - Anti-Deadlock):

```javascript
// 1. First escape: Can escape from current position?
const escapePath = findShortestEscapePath(map, player, futureBombs, ...)

// 2. Second escape: From escape destination, can reach complete safety?
const secondEscapePath = findShortestEscapePath(
  map,
  escapeDestPos,
  futureBombs,
  ...
)

if (!secondEscapePath) {
  // Escape leads to DEADLOCK - reject bombing!
}
```

**Why Second Escape?**

- Prevent bot từ đặt bomb → escape vào position bị trap bởi bombs khác
- Example: Bomb ở [13,1] → escape RIGHT → [14,1] bị kẹt giữa bomb [13,1] và [14,4]

#### 3.2 Best Position Bombing

Tìm vị trí bomb tốt nhất (destroy nhiều chests nhất):

```javascript
const chestTargets = analyzeChestTargets(map, myPos, myBomber.explosionRange)
// Returns: [{ x, y, score, chestsDestroyed, chestPositions }]

// Sort by score (chest count + proximity)
chestTargets.sort((a, b) => b.score - a.score)

// Try to path to top positions
for (const target of chestTargets.slice(0, 8)) {
  const path = findBestPath(...)
  if (path && path.length > 0) {
    return { action: path[0], fullPath: path }
  }
}
```

---

### Phase 4: Target Prioritization

**Mục đích**: Chọn target tốt nhất giữa items, chests, enemies

```javascript
const allTargets = [
  ...itemTargets.map((t) => ({ ...t, type: "ITEM" })),
  ...chestTargets.map((t) => ({ ...t, type: "CHEST" })),
  ...enemyTargets.map((t) => ({ ...t, type: "ENEMY" })),
]

// Sort by combined score
allTargets.sort((a, b) => b.finalScore - a.finalScore)

const bestTarget = allTargets[0]
```

---

### Phase 5: Target Execution

**Tùy theo target type**:

#### ITEM Target

```javascript
const path = findBestPath(map, myPos, target, bombs, ...)
return { action: path[0], fullPath: path }
```

#### CHEST Target

```javascript
// If already at position
if (isAtTarget) {
  const escapePath = findShortestEscapePath(...)
  if (escapePath) {
    return {
      action: 'BOMB',
      escapeAction: escapePath.path[0],
      isEscape: true,
      fullPath: escapePath.path
    }
  }
}
// Else path to position
const path = findBestPath(...)
return { action: path[0], fullPath: path }
```

#### ENEMY Target

```javascript
// Fight or flee decision
const shouldFight = shouldFightOrFlee(myBomber, enemy, ...)

if (shouldFight) {
  // Aggressive strategy
  const trapPath = findTrapOpportunity(...)
  return trapPath
} else {
  // Flee strategy
  return { action: 'STAY' }
}
```

---

## 3. PATHFINDING SYSTEM

### 3.1 BFS-Based Pathfinding (`findShortestEscapePath`)

**Input**:

- `map`: Grid map
- `start`: Starting position (pixel coords)
- `bombs`: All bombs (real + future)
- `strictMode`: false = allow timing-based escapes

**Output**:

```javascript
{
  path: ['RIGHT', 'DOWN', 'RIGHT'],
  target: { x: gridX, y: gridY },
  totalSteps: 3
}
```

**Algorithm Flow**:

```
1. Initialize BFS
   - Queue: [[startX, startY, [], 0]]
   - Visited: Set([startKey])

2. Separate Real vs Future Bombs
   - realBombs = bombs.filter(b => !b.isFuture)
   - unsafeTilesFromRealBombs = findUnsafeTiles(map, realBombs)

3. For each tile in queue:
   a. Check timing safety (willBeSafe)
      - Calculate time to reach: steps × (680ms/grid + 340ms align)
      - For each bomb: timeUntilExplosion - travelTime - SAFETY_BUFFER
      - Must be > 0 for all bombs

   b. Check blast zone (isOutsideBlastZones)
      - If has future bombs: Must be outside REAL bomb zones
      - If NO future bombs: Allow blast zones (rely on timing only)
      - Exception: Starting position always allowed

   c. Validate exits (hasValidExit)
      - Check 4 directions for walkable + no bomb
      - Must have at least 1 valid exit
      - Prevents deadlock in trapped positions

   d. If all checks pass:
      - Mark as safe destination
      - Return path

4. Explore neighbors (UP, DOWN, LEFT, RIGHT)
   - Skip non-walkable tiles
   - Skip visited tiles
   - Add to queue with updated path
```

**Key Timing Constants**:

```javascript
BOMB_EXPLOSION_TIME = 5000ms
TIME_PER_GRID = 680ms
ALIGNMENT_OVERHEAD = 340ms
SAFETY_BUFFER = 2100-2600ms (depends on path length)
```

### 3.2 Timing Validation (`isTileSafeByTime`)

```javascript
function isTileSafeByTime(x, y, bombs, stepCount, speed, bombers) {
  const travelTime = stepCount * (TIME_PER_GRID / speed) + ALIGNMENT_OVERHEAD
  const safetyBuffer = getSafetyBuffer(stepCount)
  const requiredTime = travelTime + safetyBuffer

  for (const bomb of bombs) {
    const timeUntilExplosion = bomb.lifeTime - (Date.now() - bomb.createdAt)

    if (isTileInBlastZone(x, y, bomb, map, bombers)) {
      if (timeUntilExplosion < requiredTime) {
        return false // NOT SAFE
      }
    }
  }

  return true // SAFE
}
```

### 3.3 Real vs Future Bomb Detection

**Future Bomb Creation**:

```javascript
function createFutureBomb(x, y, explosionRange, uid) {
  return {
    x: x * GRID_SIZE,
    y: y * GRID_SIZE,
    explosionRange,
    uid,
    createdAt: Date.now(),
    lifeTime: BOMB_EXPLOSION_TIME,
    isFuture: true, // ⭐ KEY FLAG
  }
}
```

**Detection Logic**:

```javascript
// Real bombs từ server KHÔNG có isFuture flag
const realBombs = bombs.filter((b) => !b.isFuture)

// Future bombs được tạo local có isFuture: true
const futureBombs = bombs.filter((b) => b.isFuture)
```

**Usage**:

- `isOutsideBlastZones`: Chỉ check REAL bombs (cho phép đi qua future bomb zones)
- `willBeSafe`: Check TẤT CẢ bombs (timing validation)
- `hasValidExit`: Check physical obstacles only (walls/chests/bombs)

---

## 4. ACTION EXECUTION (index.js)

### 4.1 Bomb Placement

```javascript
if (action === "BOMB") {
  placeBomb()

  // Record bomb placement
  recordBombPlacement(player.x, player.y)

  // Start escape sequence
  if (isEscape && fullPath && fullPath.length > 0) {
    pathModeManager.startEscape(fullPath)
    const firstMove = pathModeManager.getNextEscapeMove()
    setTimeout(() => {
      smoothMove(firstMove, true)
    }, STEP_DELAY)
  }
}
```

### 4.2 Smooth Movement

**Flow**:

```
1. Clear existing intervals
2. Align to grid (if needed)
3. Validate target tile walkable
4. Start movement interval
5. Check stuck detection
6. Monitor distance to target
7. Complete move
8. Continue path or make new decision
```

**Code**:

```javascript
async function smoothMove(direction, isEscapeMove = false) {
  // 1. Clear intervals
  gameContext.forceClearIntervals()

  // 2. Align to grid
  await alignToGrid(direction, myBomber, socket, gameContext)

  // 3. Calculate target
  const { nextGridX, nextGridY } = calculateNextGrid(direction, myPos)
  const targetPixel = { x: nextGridX * GRID_SIZE + offset, y: ... }

  // 4. Validate walkable
  if (!isWalkable(map, nextGridX, nextGridY, bombs, myUid)) {
    console.log('❌ BLOCKED')
    pathModeManager.abort()
    return
  }

  // 5. Start interval
  gameContext.moveIntervalId = setInterval(() => {
    // Stuck detection
    if (isStuck(currentPos, lastPos)) {
      stuckCounter++
      if (stuckCounter >= MAX_STUCK_CHECKS) {
        abort()
      }
    }

    // Distance check
    const distance = calcDistance(currentPixel, targetPixel)
    if (distance <= offset) {
      // Move complete!
      clearInterval(gameContext.moveIntervalId)

      // Continue path or make decision
      handleMoveComplete()
    } else {
      sendMoveCommand(socket, direction)
    }
  }, STEP_DELAY)
}
```

### 4.3 Path Mode Management

**Escape Mode**:

```javascript
pathModeManager.startEscape(["RIGHT", "DOWN", "RIGHT"])
// isEscaping() = true
// getRemainingEscapeSteps() = 3

const move = pathModeManager.getNextEscapeMove() // 'RIGHT'
// Remaining steps = 2

pathModeManager.completeEscape()
// isEscaping() = false
```

**Follow Mode** (for exploration/targeting):

```javascript
pathModeManager.startFollow(["UP", "UP", "LEFT"])
// isFollowing() = true

const move = pathModeManager.getNextFollowMove() // 'UP'

pathModeManager.completeFollow()
```

**Anti-Ping-Pong**:

```javascript
pathModeManager.trackEscapeFrom(x, y)
// Won't return to this position for 5000ms
```

---

## 5. STATE MANAGEMENT

### 5.1 Game Context

```javascript
gameContext = {
  currentState: {
    map: [...],           // 2D grid
    bombs: [...],         // Active bombs
    bombers: [...],       // All players
    items: [...],         // Items on map
    chests: [...],        // Remaining chests
    timestamp: 1234567890
  },
  myUid: 'ABC123',
  moveIntervalId: null,
  alignIntervalId: null
}
```

### 5.2 Bomb Tracker

**Purpose**: Track recent bomb placements để tránh spam bombing

```javascript
class BombTracker {
  recentBombs = [] // [{ x, y, timestamp }]

  recordBomb(x, y) {
    this.recentBombs.push({ x, y, timestamp: Date.now() })
  }

  wasRecentlyBombed(x, y, timeWindow = 5000) {
    return this.recentBombs.some(
      (b) => b.x === x && b.y === y && Date.now() - b.timestamp < timeWindow,
    )
  }

  cleanup() {
    // Remove old bombs (> 10s ago)
  }
}
```

### 5.3 Path Mode Manager

**States**:

- `IDLE`: No active path
- `ESCAPE`: Following escape path (high priority)
- `FOLLOW`: Following exploration/targeting path (low priority)

**Priority**:

1. Escape mode (highest)
2. Follow mode
3. New decisions (lowest)

---

## 6. ANTI-PATTERN & SAFEGUARDS

### 6.1 Deadlock Prevention

**Problem**: Bot đặt bomb → escape vào position bị trap

**Solution**: Two-level escape validation

```javascript
// Level 1: Can escape from current position?
const escapePath = findShortestEscapePath(...)

// Level 2: From escape destination, can reach safety?
const secondEscapePath = findShortestEscapePath(
  escapeDestPos,
  futureBombs,
  ...
)

if (!secondEscapePath) {
  // REJECT bombing - would lead to deadlock
}
```

### 6.2 Ping-Pong Prevention

**Problem**: Bot oscillates UP-DOWN-UP-DOWN

**Solution 1**: Prioritize path-based escape over timing-optimized

```javascript
// Try path-based first
const path = findShortestEscapePath(...)
if (path) return path

// Only fallback to timing if path fails
const direction = findPrioritizedEscapeDirection(...)
return direction
```

**Solution 2**: Track recent positions

```javascript
pathModeManager.trackEscapeFrom(x, y)
// Won't return for 5000ms
```

### 6.3 Stuck Detection

**Problem**: Bot không di chuyển được (alignment issue, lag, obstacle)

**Solution**: Monitor movement progress

```javascript
let stuckCounter = 0
setInterval(() => {
  if (isStuck(currentPos, lastPos, THRESHOLD)) {
    stuckCounter++
    if (stuckCounter >= MAX_CHECKS) {
      // Abort and re-evaluate
      pathModeManager.abort()
      makeDecision()
    }
  } else {
    stuckCounter = 0
    lastPos = currentPos
  }
}, STEP_DELAY)
```

### 6.4 Proximity-Based Danger

**Problem**: Bombs xa quá cũng block bombing

**Solution**: Distance + time filtering

```javascript
const DANGER_PROXIMITY = 6 // tiles

const nearbyDangerousBombs = bombs.filter((b) => {
  const distance = manhattanDistance(myPos, bombPos)
  const timeRemaining = getTimeRemaining(b)

  return distance <= DANGER_PROXIMITY && timeRemaining < 3000
})

// Only block if nearby AND fast-exploding
if (nearbyDangerousBombs.length > 0) {
  // Too risky
}
```

---

## 7. KEY DECISION POINTS

### When to Bomb?

✅ YES if:

- Adjacent to chest
- No nearby dangerous bombs (< 6 tiles AND < 3s)
- Has valid escape path
- Escape destination not deadlocked

❌ NO if:

- Already bombed recently (< 5s)
- No escape path
- Escape leads to trap
- Too close to other bombs

### When to Escape?

✅ IMMEDIATE if:

- Currently in blast zone
- Any bomb < 3s to explosion

✅ PLANNED if:

- Placing bomb (escape sequence)

### When to Target Items?

✅ YES if:

- EARLY/MID game
- Item score > chest score
- Path exists and timing safe

❌ NO if:

- LATE game (focus chests)
- Too risky (long path through danger)

### When to Fight Enemies?

✅ YES if:

- LATE game (≤ 2 enemies)
- Low resources (< 5 chests)
- Power ratio ≥ 80%

❌ NO if:

- EARLY/MID game
- Plenty of chests available
- Weaker than enemy

---

## 8. DEBUGGING & MONITORING

### Console Logs Structure

```
==========================================================
Start decision making...

📍 Position: [13, 1] | Pixel: [523, 40] | Orient: DOWN
💣 Active Bombs: 2
👥 Active Bombers: 1

🔍 PHASE 0: Game Context Analysis
   Game Phase: EARLY
   Risk Tolerance: 80%

🔍 PHASE 1: Safety Check
   Safety Status: ✅ SAFE | 🚨 DANGER

🔍 PHASE 2: Item Prioritization
   Items found: 3

🔍 PHASE 3: Chest Bombing
   Adjacent chest at [12, 1]
   ✅ Can escape: RIGHT to [14, 1]

🎯 DECISION: BOMB + ESCAPE
   💣 Bombing from current position
   🏃 Escape action: RIGHT
==========================================================
```

### Timing Measurements

```
📊 TIMING MEASUREMENT:
   Moved 42 grid(s) in 350ms (8.3ms/grid)
   Theoretical: 680.0ms/grid
   Diff: -671.7ms
```

### Escape Path Logs

```
🔍 BFS exhausted after exploring 15 tiles
   Real bombs: 1/2 total bombs
   Unsafe tiles from real bombs: 8
   All unsafe tiles: 12
```

---

## 9. CONFIGURATION & CONSTANTS

```javascript
// Movement
STEP_DELAY = 100 // ms between commands
GRID_SIZE = 40 // pixels per grid cell
TIME_PER_GRID = 680 // ms to cross 1 grid at speed 1
ALIGNMENT_OVERHEAD = 340 // ms for alignment

// Safety
BOMB_EXPLOSION_TIME = 5000 // ms
SAFETY_BUFFER_BASE = 2100 // ms
SAFETY_BUFFER_PER_STEP = 100 // ms
DANGER_PROXIMITY = 6 // tiles

// Pathfinding
MAX_BFS_ITERATIONS = 1000
MAX_PATH_LENGTH = 20

// Anti-spam
BOMB_PLACEMENT_COOLDOWN = 5000 // ms
POSITION_MEMORY_MS = 3000 // ms
MAX_POSITION_MEMORY = 5 // positions

// Stuck detection
MAX_STUCK_TIME = 1360 // ms (depends on speed)
MAX_STUCK_CHECKS = 13
MOVEMENT_THRESHOLD = 2 // pixels
```

---

## 10. COMMON ISSUES & SOLUTIONS

### Issue: Bot bị kẹt ping-pong

**Root Cause**: Timing-optimized fallback chọn single-step direction

**Solution**: Prioritize path-based escape

```javascript
// Try full path first
const path = findShortestEscapePath(...)
if (path) return path

// Only use timing if path fails
return findPrioritizedEscapeDirection(...)
```

### Issue: Bot đặt bomb rồi chết

**Root Cause**: Escape destination bị deadlock

**Solution**: Two-level escape validation

```javascript
const secondEscape = findShortestEscapePath(
  escapeDestPos,
  futureBombs,
  ...
)
if (!secondEscape) {
  // Reject bombing
}
```

### Issue: Bot không bomb dù có chest

**Root Cause**: Nearby bomb quá xa vẫn block

**Solution**: Proximity-based danger check

```javascript
const nearbyBombs = bombs.filter((b) => distance <= 6 && timeRemaining < 3000)
```

### Issue: Real vs future bomb detection sai

**Root Cause**: Clock skew, timing unreliable

**Solution**: Use `isFuture` flag

```javascript
// Future bombs
const futureBomb = { ..., isFuture: true }

// Detection
const realBombs = bombs.filter(b => !b.isFuture)
```

---

## 11. EXTENSION POINTS

### Adding New Strategy

1. Add phase in `decideNextAction()`:

```javascript
// Phase 6: New strategy
if (condition) {
  const result = myNewStrategy(...)
  if (result) return result
}
```

2. Create strategy file in `src/bot/strategy/`:

```javascript
export function myNewStrategy(gameState, myUid) {
  // Implementation
  return { action, fullPath, ... }
}
```

### Adding New Pathfinding Algorithm

1. Create in `src/bot/pathfinding/`:

```javascript
export function myNewPathfinder(map, start, goal, ...) {
  // Algorithm
  return { path, target, totalSteps }
}
```

2. Integrate in decision making:

```javascript
const path = myNewPathfinder(...)
if (path) return { action: path[0], fullPath: path }
```

### Adding New Event Handler

1. In `handlers/socketHandlers.js`:

```javascript
socket.on("new_event", (data) => {
  // Handle event
  // Update gameContext
  // Trigger decision if needed
})
```

---

## 12. TESTING CHECKLIST

### Unit Tests

- [ ] Pathfinding finds correct path
- [ ] Timing calculation accurate
- [ ] Bomb detection (real vs future)
- [ ] Deadlock detection works
- [ ] Escape validation correct

### Integration Tests

- [ ] Full decision cycle completes
- [ ] Path execution follows plan
- [ ] Escape mode priority correct
- [ ] Bomb placement + escape works
- [ ] Stuck detection triggers

### Scenario Tests

- [ ] Surrounded by bombs → escapes
- [ ] Adjacent chest → bombs + escapes
- [ ] Multi-bomb scenario → no ping-pong
- [ ] Deadlock position → rejects bombing
- [ ] Enemy encounter → correct fight/flee

---

## SUMMARY

**Core Principles**:

1. **Safety First**: Always validate escape before bombing
2. **Multi-Level Validation**: Timing + blast zones + physical obstacles
3. **Anti-Deadlock**: Second escape check prevents traps
4. **Real vs Future**: Distinguish server bombs from simulated bombs
5. **Path Priority**: Full paths > timing-optimized > single moves
6. **Graceful Degradation**: Fallbacks at every decision point

**Critical Files**:

- `src/index.js`: Main loop, action execution
- `src/bot/agent.js`: Decision engine (6 phases)
- `src/bot/pathfinding/pathFinder.js`: BFS escape pathfinding
- `src/bot/strategy/escapeStrategy.js`: Escape logic
- `src/handlers/socketHandlers.js`: Event handling

**Maintenance Tips**:

- Always test escape validation after pathfinding changes
- Log extensively for debugging timing issues
- Keep constants tunable (don't hardcode)
- Document WHY not just WHAT
- Use flags for feature toggles
