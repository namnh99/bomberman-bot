# Bomberman Bot - Escape Logic Documentation

## 🚨 Critical Features

### 1. **Escape Path Re-evaluation on New Bombs**

**Problem:** Enemy places a bomb during our escape sequence, blocking our planned path.

**Solution:** Active monitoring with intelligent re-routing:

```javascript
// In new_bomb event handler (index.js)
if (escapeMode && escapePath.length > 0) {
  // Simulate remaining escape path
  // Check if any step goes through new bomb's explosion radius
  if (pathCompromised) {
    // ABORT current escape
    // Clear intervals
    // Re-calculate new escape route immediately
  }
}
```

**Behavior:**

- ✅ Bot detects new bomb during escape
- ✅ Simulates remaining path through unsafe tiles
- ✅ If compromised → **ABORT** and find new route
- ✅ If still safe → **CONTINUE** original path
- ✅ Logs: `🚨 NEW BOMB during escape! Checking if escape path is still safe...`

**Example Scenario:**

```
1. Bot places bomb at [3,4]
2. Escape path: [RIGHT, RIGHT, DOWN]
3. Enemy places bomb at [5,3] (blocking step 2)
4. Bot detects compromise at [5,3]
5. Bot ABORTS, recalculates: [UP, RIGHT, RIGHT]
6. Bot escapes safely
```

---

### 2. **Bomb Blocking Behavior**

**Problem:** Bombs have asymmetric walkability - you can walk OFF but not back ON.

**Implementation in `findBestPath()` and `findShortestEscapePath()`:**

```javascript
// Check if we're currently standing on a bomb (just placed it)
const startKey = `${start.x},${start.y}`
const standingOnBomb = bombTiles.has(startKey)

// During BFS pathfinding
if (bombTiles.has(key)) {
  // Allow stepping OFF the bomb we're standing on (first move only)
  if (standingOnBomb && isAdjacentToStart(nx, ny)) {
    // ✅ This is the first step off our bomb - ALLOW
  } else {
    // ❌ This is a different bomb tile - BLOCK
    continue
  }
}
```

**Rules:**

1. **Standing on bomb → Can move to ANY adjacent tile** (one step off)
2. **Not standing on bomb → CANNOT move onto ANY bomb tile**
3. **After stepping off → Cannot step back on** (no longer "standing on bomb")

**Visual Example:**

```
Before placing bomb at [3,3]:
[ ][ ][X][ ][ ]
[ ][ ][ ][ ][ ]  X = Player
[ ][B][💣][B][ ]  💣 = Player's bomb (just placed)
[ ][ ][ ][ ][ ]  B = Blocks (can walk to from bomb)
[ ][ ][ ][ ][ ]

After one step RIGHT to [4,3]:
[ ][ ][ ][X][ ]
[ ][ ][ ][ ][ ]  X = Player (new position)
[ ][?][💣][B][ ]  💣 = Bomb (now BLOCKED)
[ ][ ][ ][ ][ ]  ? = Can no longer return here
[ ][ ][ ][ ][ ]  B = Can still move here
```

**Key Constraints:**

- ✅ `standingOnBomb = true` → First step allowed in 4 directions
- ❌ `standingOnBomb = false` → Bomb tile is impassable
- ✅ Prevents bot from walking back into bomb after escaping
- ✅ Prevents bot from walking onto enemy bombs

---

## 🧠 Escape Mode State Machine

### States:

1. **NORMAL** - `escapeMode = false`
   - Bot makes decisions normally
   - Events trigger `makeDecision()`
2. **ESCAPING** - `escapeMode = true, escapePath = [...]`
   - Bot executes pre-planned escape sequence
   - Most events are IGNORED
   - Only `new_bomb` event triggers re-evaluation
   - `makeDecision()` returns early if called

3. **ESCAPE COMPLETE** - `escapeMode = false, escapePath = []`
   - Bot waits 1 second for bombs to explode
   - Then re-evaluates safety

### Transitions:

```
NORMAL → ESCAPING
  Trigger: decision.isEscape = true && fullPath.length > 1
  Action: Set escapeMode = true, copy fullPath to escapePath

ESCAPING → ESCAPING
  Trigger: Move completed but escapePath.length > 0
  Action: Execute next move in sequence

ESCAPING → NORMAL (abort)
  Trigger: New bomb compromises escape path
  Action: Clear intervals, makeDecision()

ESCAPING → ESCAPE COMPLETE
  Trigger: Move completed and escapePath.length = 0
  Action: Wait 1s, then makeDecision()
```

---

## 🛡️ Event Handling During Escape

### Events That Are **IGNORED** During Escape:

- ✅ `user` (state updates) - **Skipped**
- ✅ `bomb_explode` - **Skipped**
- ✅ `chest_destroyed` - **Skipped**
- ✅ `item_collected` - **Skipped**

### Events That Are **PROCESSED** During Escape:

- ⚠️ `new_bomb` - **Re-evaluates escape path**

### Logs During Escape:

```
🏃 ESCAPE MODE ACTIVE - Skipping decision (2 steps remaining)
🏃 Escape in progress, ignoring bomb explosion event
🏃 Continuing escape: RIGHT (1 steps remaining)
✅ Escape sequence completed!
```

---

## 📊 Decision Flow

```
makeDecision() called
  ├─ manualMode? → return
  ├─ escapeMode? → return (CRITICAL: Never interrupt)
  ├─ Move in progress? → return (Skip decision)
  └─ Execute decision logic
      ├─ Safety check
      ├─ If unsafe → Find escape path
      │   └─ If multi-step → Enter ESCAPE MODE
      └─ If safe → Find targets (items/chests)
```

---

## 🔧 Configuration

### Timing Constants:

- `STEP_DELAY` - Interval between move commands (default: 16ms)
- **50ms** - Delay between escape moves (ensures position update)
- **100ms** - Delay after normal moves (ensures position update)
- **1000ms** - Delay after escape completes (lets bombs explode)

### Speed Scaling:

- Each move command moves `speed` pixels
- Steps needed = `Math.ceil(pixelsToMove / speed)`
- Higher speed = fewer steps = faster movement

---

## 🐛 Debugging

### Key Log Patterns:

**Escape Started:**

```
🚨 Entering ESCAPE MODE - 3 step sequence
🏃 Starting smooth move: RIGHT (speed: 1, pixels: 42.5)
```

**Escape Interrupted by New Bomb:**

```
🚨 NEW BOMB during escape! Checking if escape path is still safe...
⚠️  Escape path compromised at step [5, 3]!
🔄 ABORT ESCAPE - Finding new escape route!
```

**Escape Completed:**

```
✅ Escape sequence completed!
⏸️  Waiting before next decision to ensure safety...
🔍 Re-evaluating safety after escape...
```

**Escape Skipped Decision:**

```
🏃 ESCAPE MODE ACTIVE - Skipping decision (2 steps remaining)
```

---

## ⚠️ Known Edge Cases

### 1. Multiple Bombs in Escape Path

- ✅ Handled: `findUnsafeTiles()` considers ALL active bombs
- ✅ Escape path validated against all bomb zones

### 2. Speed Boost During Escape

- ✅ Handled: Speed variable updated by `item_collected` event
- ✅ Subsequent moves use updated speed

### 3. Bomb Explodes During Escape

- ✅ Handled: Explosion removes bomb from state
- ✅ Path remains valid (no re-evaluation needed)
- ✅ Event is logged but ignored

### 4. Enemy Blocks Escape Route

- ⚠️ Not handled: Enemies are not considered blocking tiles
- 💡 Future: Could add enemy position checking

---

## 📝 Code Locations

| Feature                  | File                      | Lines                  |
| ------------------------ | ------------------------- | ---------------------- |
| Escape mode check        | `index.js`                | ~388-392               |
| New bomb re-evaluation   | `index.js`                | ~210-257               |
| Event guards             | `index.js`                | ~170, ~263, ~286, ~298 |
| Bomb blocking logic      | `bomberman_beam_agent.js` | ~162-174, ~251-263     |
| Unsafe tiles calculation | `bomberman_beam_agent.js` | ~25-50                 |
| Shortest escape path     | `bomberman_beam_agent.js` | ~197-275               |

---

## 🚀 Testing Scenarios

### Test 1: Basic Escape

1. Bot places bomb
2. Enters escape mode with path [RIGHT, RIGHT]
3. Completes both moves
4. Waits 1s, re-evaluates

### Test 2: Interrupted Escape

1. Bot places bomb at [3,3]
2. Escape path [RIGHT, RIGHT, DOWN]
3. After first RIGHT, enemy places bomb at [5,3]
4. Bot detects compromise
5. Aborts and finds new path [UP, RIGHT]

### Test 3: Bomb Blocking

1. Bot at [3,3], places bomb
2. Can move to [2,3], [4,3], [3,2], [3,4]
3. Moves to [4,3]
4. Cannot move back to [3,3] (bomb blocks)

---

## 🎯 Success Criteria

- ✅ Bot never gets stuck in escape loops
- ✅ Bot never walks back into bomb after escaping
- ✅ Bot adapts to new bombs during escape
- ✅ Bot waits for bombs to explode before re-evaluating
- ✅ Escape sequences complete without interruption (unless compromised)
