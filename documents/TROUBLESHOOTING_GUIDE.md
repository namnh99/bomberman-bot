# Bomberman Bot - Troubleshooting Guide

## Quick Diagnosis

### Bot không di chuyển

**Check:**

1. Console có log "Start decision making..." không?
   - NO → Socket connection issue
   - YES → Tiếp tục check

2. Console có log decision (BOMB/MOVE/STAY)?
   - NO → Decision logic bị block
   - YES → Execution issue

3. Console có "Moving [direction]..."?
   - NO → smoothMove() không được gọi
   - YES → Movement stuck

**Common Causes:**

```javascript
// 1. Manual mode active
if (manualControlManager.isManualMode()) {
  return // ← Bot bị disable
}

// 2. Path mode blocking
if (pathModeManager.isFollowing()) {
  return // ← Đang follow path
}

// 3. Move in progress
if (gameContext.moveIntervalId) {
  return // ← Interval chưa clear
}

// 4. Stuck detection triggered
if (stuckCounter >= MAX_STUCK_CHECKS) {
  // Bot phát hiện stuck → abort
}
```

**Solution:**

```javascript
// Force clear intervals
gameContext.forceClearIntervals()

// Reset path modes
pathModeManager.abortEscape()
pathModeManager.abortFollow()

// Disable manual mode
manualControlManager.setManualMode(false)
```

---

### Bot cứ STAY

**Symptoms:**

```
🎯 DECISION: STAY
⏸️  Staying put
```

**Check Phase Logs:**

#### Phase 1: Safety Check

```
🔍 PHASE 1: Safety Check
   Safety Status: ✅ SAFE | 🚨 DANGER
```

If **DANGER**:

- Check escape path found?

```
🔍 BFS exhausted - NO ESCAPE FOUND
   Real bombs: 2/2 total bombs
```

- Problem: Không tìm được escape path
- Solution: Check pathfinding logic

#### Phase 2-3: No Items/Chests

```
🔍 PHASE 2: Items found: 0
🔍 PHASE 3: Chests found: 0
```

- Problem: Không còn targets
- Check: Map đã clear hết chưa?

#### Phase 3: No Path to Targets

```
🔍 PHASE 3: Chest Bombing
   ❌ No path found to any chest positions
```

- Problem: Tất cả paths đều unsafe
- Check: Timing calculation có đúng không?

**Debug Commands:**

```javascript
// In console
console.log("Safe tiles:", findSafeTiles(map, bombs, bombers, myBomber))
console.log("Unsafe tiles:", findUnsafeTiles(map, bombs, bombers))
console.log("My position:", toGridCoords(player.x, player.y))
```

---

### Bot đặt bomb rồi chết

**Symptoms:**

```
🎯 DECISION: BOMB + ESCAPE
💣 Bombing from current position
🏃 Escape action: RIGHT

[Bot dies after moving RIGHT]
```

**Root Causes:**

#### 1. Escape Timing Wrong

**Check log:**

```
🕐 Timing check [14,2]: 2 steps @ speed 1 = 1700ms
   💣 Bomb [14,4]: Time until explosion: 1500ms
   💥 Need 1700ms + 2100ms buffer vs 1500ms available → ❌ UNSAFE
```

**Problem**: Timing calculation sai hoặc buffer không đủ

**Debug:**

```javascript
// Check actual timing
const TIME_PER_GRID = 680 / myBomber.speed // Should be 680 for speed 1
const ALIGNMENT = 340
const BUFFER = 2100 + stepCount * 100

const required = stepCount * TIME_PER_GRID + ALIGNMENT + BUFFER
const available = BOMB_EXPLOSION_TIME - (Date.now() - bomb.createdAt)

console.log("Required time:", required)
console.log("Available time:", available)
console.log("Safe?", available > required)
```

#### 2. Escape Destination Deadlocked

**Check log:**

```
✅ Can escape: RIGHT to [14, 1]
```

**But no second escape log!**

Nếu không có log này:

```
⚠️ Escape destination [14, 1] leads to DEADLOCK
```

→ Problem: Second escape validation không chạy hoặc pass sai

**Debug:**

```javascript
// After finding first escape
const escapeDestPos = {
  x: destX * GRID_SIZE,
  y: destY * GRID_SIZE,
}

console.log("Checking second escape from:", escapeDestPos)

const secondEscapePath = findShortestEscapePath(
  map,
  escapeDestPos,
  futureBombs,
  bombers,
  myBomber,
  false,
)

console.log("Second escape result:", secondEscapePath)

if (!secondEscapePath) {
  console.log("⚠️ DEADLOCK DETECTED - should not bomb")
}
```

#### 3. Real vs Future Bomb Detection Sai

**Check log:**

```
Real bombs: 0/2 total bombs  ← WRONG! Should be 1/2 or 2/2
```

**Problem**: Future bombs được nhận diện nhầm là real

**Debug:**

```javascript
bombs.forEach((b) => {
  console.log("Bomb:", {
    position: [Math.floor(b.x / 40), Math.floor(b.y / 40)],
    isFuture: b.isFuture,
    hasId: b.id !== undefined,
    createdAt: b.createdAt,
    timeDiff: Date.now() - b.createdAt,
  })
})
```

**Expected:**

- Server bombs: `isFuture: undefined/false`, `hasId: true`
- Future bombs: `isFuture: true`, `hasId: undefined`

**Fix nếu sai:**

```javascript
// In createFutureBomb()
return {
  // ...
  isFuture: true, // ← MUST have this
  // DO NOT set 'id' field
}

// In pathfinder
const realBombs = bombs.filter((b) => !b.isFuture) // ← Correct filter
```

---

### Bot bị ping-pong (UP-DOWN-UP-DOWN)

**Symptoms:**

```
Moving DOWN to [14, 2]
✅ Move complete: DOWN
Moving UP to [14, 1]
✅ Move complete: UP
Moving DOWN to [14, 2]  ← LOOP!
```

**Root Cause:**

#### 1. Timing-Optimized Fallback

**Check log:**

```
🕐 Path-based escape failed - trying timing-optimized direction...
🎯 Escape direction priorities (by bomb timing):
   ✅ ⚠️ DOWN → [14,2] | time margin: 1.7s

✅ Using timing-optimized direction: DOWN
```

**Problem**: Timing-optimized chọn single direction based on time margin, không check destination có trap không

**Solution**: Prioritize path-based escape

```javascript
// In attemptEscape() - escapeStrategy.js
// Try path-based FIRST
const path = findShortestEscapePath(...)
if (path && path.length > 0) {
  return {
    action: path[0],
    fullPath: path,
    isEscape: true
  }
}

// Only use timing-optimized as FALLBACK
const direction = findPrioritizedEscapeDirection(...)
```

#### 2. No Future Bombs Logic Not Working

**Check log:**

```
Real bombs: 2/2 total bombs
```

**If NO escape found** → `!hasFutureBombs` logic might not be working

**Debug:**

```javascript
// In pathFinder.js
const realBombs = bombs.filter((b) => !b.isFuture)
const futureBombs = bombs.filter((b) => b.isFuture)
const hasFutureBombs = futureBombs.length > 0

console.log("Real bombs:", realBombs.length)
console.log("Future bombs:", futureBombs.length)
console.log("Has future bombs?", hasFutureBombs)

// In BFS loop
const isOutsideBlastZones =
  !unsafeTilesFromRealBombs.has(key) || path.length === 0 || !hasFutureBombs // ← Should be true when no future bombs

console.log("Outside blast zones?", isOutsideBlastZones)
```

**Fix:**

```javascript
// Make sure this logic is correct
if (!hasFutureBombs) {
  // Allow escape through blast zones
  // Only rely on timing validation
  isOutsideBlastZones = true
}
```

#### 3. Position Memory Not Working

**Check:**

```javascript
// In PathModeManager
trackEscapeFrom(x, y) {
  this.recentEscapePositions.push({
    x, y,
    timestamp: Date.now()
  })
}

// Should prevent returning to [14,1] for 5000ms
```

**Debug:**

```javascript
console.log("Recent escape positions:", pathModeManager.recentEscapePositions)
```

---

### Bot không bomb dù đứng cạnh chest

**Symptoms:**

```
🔍 PHASE 3: Adjacent Chest Bombing
   🧱 Adjacent chest at [12, 1]
   ⚠️ 1 NEARBY bomb(s) about to explode - TOO RISKY
      💣 Bomb at [14, 4] explodes in 2500ms (2 tiles away)
   🎯 Skipping bomb placement - will focus on staying safe
```

**Root Causes:**

#### 1. Proximity Check Too Strict

**Check:**

```javascript
const DANGER_PROXIMITY = 6 // tiles

const nearbyDangerousBombs = bombs.filter((b) => {
  const distance = Math.abs(b.gridX - gridX) + Math.abs(b.gridY - gridY)
  const timeRemaining = b.lifeTime - timeSincePlaced

  return distance <= DANGER_PROXIMITY && timeRemaining < 3000
})
```

**Problem**: Bomb xa 14 tiles vẫn block vì chỉ check distance HOẶC time

**Should be**: distance <= 6 **AND** time < 3s

**Debug:**

```javascript
bombs.forEach((b) => {
  const dist = Math.abs(b.gridX - gridX) + Math.abs(b.gridY - gridY)
  const time = b.lifeTime - (Date.now() - b.createdAt)
  console.log("Bomb check:", {
    position: [b.gridX, b.gridY],
    distance: dist,
    timeRemaining: time,
    isDangerous: dist <= 6 && time < 3000,
  })
})
```

#### 2. Escape Validation Fails

**Check:**

```javascript
const escapePath = findShortestEscapePath(...)
if (!escapePath) {
  console.log('❌ No escape path, cannot bomb safely')
}
```

**Debug why no escape:**

```javascript
// Add verbose logging in findShortestEscapePath
console.log("BFS start:", start)
console.log("Bombs:", bombs.length)
console.log("Real bombs:", realBombs.length)

// In BFS loop
console.log("Checking tile:", [x, y])
console.log("  willBeSafe?", willBeSafe)
console.log("  isOutsideBlastZones?", isOutsideBlastZones)
console.log("  hasValidExit?", hasValidExit)
```

#### 3. Second Escape Fails (Deadlock)

**Check:**

```javascript
⚠️ Escape destination [14, 1] leads to DEADLOCK
   (Can escape immediate bomb, but will be trapped by other bombs)
```

**This is CORRECT behavior** - bot correctly detecting deadlock

**To verify:**

- Manually check map: Có path thoát từ [14,1] không?
- Nếu có bombs blocking → log đúng
- Nếu không có bombs → bug trong second escape logic

---

### Bot không pick items

**Symptoms:**

```
🔍 PHASE 2: Item Prioritization
   Items found: 3
   [Items listed but not targeted]
```

**Check Phase 4:**

```
🔍 PHASE 4: Target Prioritization
   ✅ Only CHEST found
```

**Problem**: Chest score > item score

**Debug Scoring:**

```javascript
// In prioritizeTargets()
const itemScore = calculateItemScore(item, myPos, ...)
const chestScore = calculateChestScore(chest, myPos, ...)

console.log('Item scores:', itemTargets.map(i => i.score))
console.log('Chest scores:', chestTargets.map(c => c.score))
console.log('Best item:', Math.max(...itemTargets.map(i => i.score)))
console.log('Best chest:', Math.max(...chestTargets.map(c => c.score)))
```

**Factors Affecting Score:**

- Distance (closer = higher score)
- Risk (safer = higher score)
- Phase multiplier (EARLY = items favored, LATE = chests favored)
- Item type (speed > power > flame)

**Adjust if needed:**

```javascript
// In priorityCalculator.js
const ITEM_PHASE_MULTIPLIERS = {
  EARLY: 2.0, // ← Increase to favor items more
  MID: 1.5,
  LATE: 0.5,
}
```

---

### Timing Measurements Off

**Symptoms:**

```
📊 TIMING MEASUREMENT:
   Moved 42 grid(s) in 350ms (8.3ms/grid)
   Theoretical: 680.0ms/grid
   Diff: -671.7ms  ← HUGE difference
```

**Root Causes:**

#### 1. Server Updates Position Instantly

Server may teleport player to destination instead of smooth movement

**Check:**

```javascript
// In smoothMove()
console.log("Movement start:", { x: myBomber.x, y: myBomber.y })
console.log("Movement end:", { x: myBomber.x, y: myBomber.y })
console.log("Elapsed:", Date.now() - startTime)
```

If elapsed time << theoretical time → server teleporting

**Solution**: Use theoretical timing for safety calculations

```javascript
const TIME_PER_GRID = 680 // Don't use actual measurements
```

#### 2. Grid Distance Wrong

```javascript
const gridMoved =
  Math.abs(myBomber.x - movementStartGrid.x) + Math.abs(myBomber.y - movementStartGrid.y)
```

Problem: X/Y are in pixels, not grids!

**Fix:**

```javascript
const gridMoved =
  Math.abs(Math.floor(myBomber.x / GRID_SIZE) - startGrid.x) +
  Math.abs(Math.floor(myBomber.y / GRID_SIZE) - startGrid.y)
```

#### 3. Speed Not Factored

```javascript
const TIME_PER_GRID = 680 / myBomber.speed

// Speed 1: 680ms
// Speed 2: 340ms
// Speed 3: 227ms
```

---

## Performance Issues

### Bot lag/delay

**Check:**

#### 1. Too Many BFS Iterations

```javascript
console.log("BFS explored:", exploredCount)
```

If > 500 tiles → too many iterations

**Solution**: Add max iterations limit

```javascript
const MAX_BFS_ITERATIONS = 1000

while (queue.length && exploredCount < MAX_BFS_ITERATIONS) {
  exploredCount++
  // ...
}
```

#### 2. Unnecessary Re-calculations

```javascript
// BAD: Calculate every frame
const unsafeTiles = findUnsafeTiles(map, bombs, bombers) // EXPENSIVE

// GOOD: Cache and invalidate
if (bombsChanged) {
  cachedUnsafeTiles = findUnsafeTiles(map, bombs, bombers)
}
```

#### 3. Too Many Console Logs

Comment out verbose logs in production:

```javascript
const DEBUG = false

if (DEBUG) {
  console.log("Detailed debug info...")
}
```

---

## Emergency Fixes

### Bot completely broken

```javascript
// 1. Reset all state
gameContext.forceClearIntervals()
pathModeManager.abortEscape()
pathModeManager.abortFollow()

// 2. Force new decision
setTimeout(() => {
  makeDecision()
}, 500)
```

### Stuck in infinite loop

```javascript
// Add circuit breaker
let decisionCount = 0
const MAX_DECISIONS_PER_SECOND = 10

function makeDecision() {
  decisionCount++

  if (decisionCount > MAX_DECISIONS_PER_SECOND) {
    console.error("⚠️ CIRCUIT BREAKER: Too many decisions")
    return
  }

  // Reset counter after 1s
  setTimeout(() => {
    decisionCount = 0
  }, 1000)

  // ... normal decision logic
}
```

### Memory leak

```javascript
// Clear old data periodically
setInterval(() => {
  bombTracker.cleanup()
  pathModeManager.cleanupOldPositions()
}, 10000)
```

---

## Testing Strategies

### Unit Test Pathfinding

```javascript
function testPathfinding() {
  const map = [
    ['W','W','W','W','W'],
    ['W','.','.','.','W'],
    ['W','.','W','.','W'],
    ['W','.','.','B','W'],
    ['W','W','W','W','W']
  ]

  const bombs = [{
    x: 3*40, y: 3*40,
    explosionRange: 2,
    createdAt: Date.now(),
    lifeTime: 5000
  }]

  const start = { x: 1*40, y: 1*40 }

  const path = findShortestEscapePath(map, start, bombs, ...)

  console.assert(path !== null, 'Should find escape path')
  console.assert(path.path.length > 0, 'Path should not be empty')
}
```

### Integration Test

```javascript
function testBombAndEscape() {
  // Setup: Bot next to chest
  const decision = decideNextAction(gameState, myUid)

  console.assert(decision.action === "BOMB", "Should bomb")
  console.assert(decision.isEscape === true, "Should have escape")
  console.assert(decision.fullPath.length > 0, "Should have path")

  // Verify escape destination safe
  const dest = getDestination(decision.fullPath)
  const isSafe = !isInBlastZone(dest, bombs)

  console.assert(isSafe, "Escape destination should be safe")
}
```

### Scenario Testing

```javascript
// Test deadlock prevention
function testDeadlockPrevention() {
  const gameState = {
    // Bot at [13,1]
    // Bomb already at [14,4]
    // Chest at [12,1]
  }

  const decision = decideNextAction(gameState, myUid)

  // Should NOT bomb (would lead to deadlock at [14,1])
  console.assert(decision.action !== "BOMB", "Should not bomb - leads to deadlock")
}
```

---

## Monitoring Dashboard

### Key Metrics to Track

```javascript
const metrics = {
  // Performance
  avgDecisionTime: 0,
  avgPathfindingTime: 0,
  bfsIterationsAvg: 0,

  // Behavior
  bombsPlaced: 0,
  escapeSuccess: 0,
  escapeFailed: 0,
  deaths: 0,

  // Decisions
  decisionStay: 0,
  decisionMove: 0,
  decisionBomb: 0,
  decisionEscape: 0,
}

// Log periodically
setInterval(() => {
  console.table(metrics)
}, 10000)
```

### Health Check

```javascript
function healthCheck() {
  const issues = []

  // Check intervals
  if (gameContext.moveIntervalId && Date.now() - lastMoveTime > 5000) {
    issues.push("Move interval stuck")
  }

  // Check path mode
  if (pathModeManager.isEscaping() && escapePath.length === 0) {
    issues.push("Escape mode with empty path")
  }

  // Check position
  const pos = toGridCoords(player.x, player.y)
  if (isInBlastZone(pos, bombs)) {
    issues.push("Currently in danger")
  }

  return issues
}
```

---

## Prevention Checklist

Trước khi deploy changes:

- [ ] Test với 1 bomb scenario
- [ ] Test với multi-bomb scenario
- [ ] Test deadlock prevention
- [ ] Test ping-pong scenarios
- [ ] Verify timing calculations
- [ ] Check real vs future bomb detection
- [ ] Test adjacent chest bombing
- [ ] Verify escape path validation
- [ ] Check logs có clear không
- [ ] Performance acceptable (< 100ms decision time)

Sau khi deploy:

- [ ] Monitor first 10 decisions
- [ ] Check for any errors in console
- [ ] Verify bot không stuck
- [ ] Confirm escape sequences work
- [ ] Watch for any infinite loops
- [ ] Check memory usage stable
