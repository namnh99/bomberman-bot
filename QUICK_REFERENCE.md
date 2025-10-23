# Bomberman Bot - Quick Reference

## 🎯 What We Fixed

### Problem 1: Escape Interruption

**Before:**

```
Bot escaping → Game event → makeDecision() called → Escape CANCELED → Bot stuck
```

**After:**

```
Bot escaping → Game event → Checked escapeMode → Event IGNORED → Escape continues
```

### Problem 2: No New Bomb Detection During Escape

**Before:**

```
Bot escaping [RIGHT, RIGHT, DOWN]
Enemy places bomb in path
Bot continues blindly → 💥 DEAD
```

**After:**

```
Bot escaping [RIGHT, RIGHT, DOWN]
Enemy places bomb at [5,3]
Bot simulates remaining path → Detects danger at [5,3]
Bot ABORTS → Finds new path [UP, RIGHT, RIGHT] → ✅ SAFE
```

---

## 🔑 Key Concepts

### 1. Escape Mode Protection

```javascript
// In makeDecision()
if (escapeMode) {
  console.log("🏃 ESCAPE MODE ACTIVE - Skipping decision")
  return // CRITICAL: Never interrupt escape
}
```

### 2. Bomb Blocking Rules

```
YOU ARE HERE:  [💣]

Can move to:   [✅][✅][✅][✅]  (All adjacent tiles)
               [✅][💣][✅]
               [✅][✅][✅]

AFTER MOVING:  [ ][X][ ]      X = Your new position
               [ ][❌][ ]      ❌ = Can no longer walk on bomb
               [ ][ ][ ]
```

### 3. Escape Path Validation (New!)

```javascript
// When new bomb appears during escape
for (const step of escapePath) {
  // Simulate each remaining step
  if (unsafeTiles.has(`${nextX},${nextY}`)) {
    // Path compromised! Find new route
    escapeMode = false
    makeDecision()
    break
  }
}
```

---

## 🎮 State Machine

```
     ┌──────────────┐
     │    NORMAL    │
     │ Making       │
     │ Decisions    │
     └──────┬───────┘
            │
            │ Unsafe! Need multi-step escape
            ▼
     ┌──────────────┐
     │  ESCAPING    │◄────┐
     │ Following    │     │
     │ Escape Path  │     │ More steps
     └──────┬───────┘     │
            │              │
            ├──────────────┘
            │
            │ 🚨 NEW BOMB in path?
            ├──────────────┐
            │              │
            │ No           │ Yes
            ▼              ▼
     ┌──────────────┐  ┌──────────────┐
     │   COMPLETE   │  │    ABORT     │
     │ Wait 1s for  │  │ Find new     │
     │ Bombs        │  │ escape route │
     └──────┬───────┘  └──────┬───────┘
            │                  │
            └──────┬───────────┘
                   ▼
            ┌──────────────┐
            │    NORMAL    │
            │ Re-evaluate  │
            └──────────────┘
```

---

## 📋 Event Handling Matrix

| Event                 | Normal Mode            | Escaping Mode    | Escape Complete        |
| --------------------- | ---------------------- | ---------------- | ---------------------- |
| `user` (state update) | ✅ Call makeDecision() | ❌ Skip          | ✅ Call makeDecision() |
| `new_bomb`            | ✅ Call makeDecision() | ⚠️ Validate path | ✅ Call makeDecision() |
| `bomb_explode`        | ✅ Call makeDecision() | ❌ Skip          | ✅ Call makeDecision() |
| `chest_destroyed`     | ✅ Call makeDecision() | ❌ Skip          | ✅ Call makeDecision() |
| `item_collected`      | ✅ Call makeDecision() | ❌ Skip          | ✅ Call makeDecision() |

---

## 🐛 Debug Checklist

### Issue: Bot keeps making same decision

- [ ] Check: Is `escapeMode` being set correctly?
- [ ] Check: Are intervals being cleared after completion?
- [ ] Check: Are events calling `makeDecision()` during escape?

### Issue: Bot walks back into bomb

- [ ] Check: Is `standingOnBomb` calculated correctly?
- [ ] Check: Is bomb blocking logic checking ADJACENT tiles only?
- [ ] Check: Are bomb tiles being blocked after first step?

### Issue: Bot dies during escape

- [ ] Check: Is escape path validated against ALL bombs?
- [ ] Check: Is new bomb detection working?
- [ ] Check: Is escape path simulation correct?

---

## 🚀 Quick Test

```javascript
// Test escape mode protection
console.log("Test 1: Escape mode protection")
escapeMode = true
escapePath = ["RIGHT", "DOWN"]
makeDecision() // Should return immediately with log

// Test bomb blocking
console.log("Test 2: Bomb blocking")
// Place bomb at [3,3], move to [4,3]
// Try to move back to [3,3] → Should be blocked

// Test new bomb detection
console.log("Test 3: New bomb during escape")
// Start escape with path [RIGHT, RIGHT, DOWN]
// Emit new_bomb at [5,3]
// Should abort and find new path
```

---

## 💡 Pro Tips

1. **Always check `escapeMode` first** in `makeDecision()`
2. **Never clear intervals during escape** (unless aborting)
3. **Simulate escape path** when new bombs appear
4. **Wait after escape completes** (1s delay for bomb explosions)
5. **Log state changes** for easier debugging

---

## 📞 Code References

```javascript
// Check escape mode
if (escapeMode) return

// Start escape mode
escapeMode = true
escapePath = [...fullPath]
smoothMove(escapePath.shift(), true)

// Abort escape
escapeMode = false
escapePath = []
clearInterval(moveIntervalId)
makeDecision()

// Complete escape
escapeMode = false
escapePath = []
setTimeout(() => makeDecision(), 1000)
```

---

## ✅ Success Indicators

Look for these logs:

```
🚨 Entering ESCAPE MODE - 3 step sequence
🏃 Continuing escape: RIGHT (2 steps remaining)
✅ Escape sequence completed!
⏸️  Waiting before next decision to ensure safety...
```

Avoid these logs:

```
⏸️  Move in progress, canceling to make new decision  ❌ BAD!
🏃 Escape in progress, ignoring new bomb event         ⚠️  Check path!
```
