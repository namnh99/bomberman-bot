# Staged Escape Strategy - Technical Documentation

## Concept

**Staged Escape** là chiến thuật escape thông minh khi đối mặt với nhiều bombs có timing khác nhau.

### Traditional Escape (Current)

```
Bombs: A (1.5s), B (3.5s)
Bot position: [10, 12]

Strategy: Tìm path tránh CẢ 2 bombs ngay lập tức
Problem: Khó tìm path vì phải tránh 2 blast zones, timing rất tight
```

### Staged Escape (New)

```
Bombs: A (1.5s), B (3.5s)
Bot position: [10, 12]

Strategy:
  Step 1: Di chuyển đến vị trí AN TOÀN với Bomb A
  Step 2: ĐỢI Bomb A nổ (1.5s)
  Step 3: Escape từ Bomb B (giờ chỉ còn 1 bomb, dễ hơn)

Benefits:
  - Giảm số bombs từ 2 → 1
  - Terrain tốt hơn (walls/chests destroyed)
  - Timing margin dễ thở hơn
```

---

## Algorithm Flow

### 1. Detection Phase

```javascript
// Only activate if:
// - Multiple bombs (≥ 2)
// - Fastest bomb: 500ms < time < 2500ms
// - Have time to reach safe position

if (bombs.length < 2) return null
if (fastestBomb.timeRemaining > 2500 || fastestBomb.timeRemaining < 500) return null
```

### 2. Position Search

Tìm vị trí đáp ứng:

**MUST criteria**:

1. ✅ **Safe from fastest bomb** (ngoài blast zone)
2. ✅ **Reachable in time** (travel time + buffer < bomb time)
3. ✅ **Walkable terrain**

**PREFER criteria**:

1. ⭐ **Outside ALL blast zones** (completely safe)
2. ⭐ **Close to current position** (less risky travel)
3. ⭐ **Good wait safety margin** (nếu vẫn trong blast zones khác)

### 3. Scoring System

```javascript
score = 0

// Proximity bonus (closer = better)
score += (10 - distance) * 100

// Time margin bonus
score += timeAfterArrival / 10

// HUGE bonus if completely safe
if (!isInRemainingBlastZones) {
  score += 10000 // Best case!
} else {
  // Partial bonus based on wait safety margin
  score += waitSafetyMargin / 10
}
```

### 4. Validation

```javascript
// Must have:
// 1. Time margin > 500ms after reaching position
// 2. Can wait safely for ≥ 1s OR completely outside remaining zones

const isViable =
  timeUntilFastBombExplodes > 500 && (waitSafetyMargin > 1000 || !isInRemainingBlastZones)
```

---

## Example Scenarios

### Scenario 1: Perfect Wait (Best Case)

```
Map:
  . . . . .
  . A . . .
  . . X . .
  . . . B .
  . . . . .

Bombs:
  A at [1,1]: 1.2s remaining
  B at [3,3]: 3.8s remaining

Bot at X [2,2]:
  - In blast zone of BOTH bombs
  - Traditional escape: Very difficult

Staged Escape:
  1. Move to [4,2] (2 tiles RIGHT)
     - Safe from A ✅
     - Safe from B ✅
     - Travel: 2 * 680ms = 1360ms
     - Margin: 1200ms - 1360ms = FAIL!

  2. Move to [2,4] (2 tiles DOWN)
     - Safe from A ✅
     - Still in B's zone (vertical)
     - Travel: 1360ms + 340ms = 1700ms
     - Can't make it!

  3. STAY and find different approach...
```

### Scenario 2: Tactical Wait

```
Map:
  W W W W W
  W . . . W
  W A X B W
  W . . . W
  W W W W W

Bombs:
  A at [1,2]: 1.5s
  B at [3,2]: 3.0s

Bot at X [2,2]:
  - Trapped between 2 bombs horizontally

Staged Escape:
  1. Move UP to [2,1]
     - Outside A's blast (horizontal only) ✅
     - Outside B's blast (horizontal only) ✅
     - Travel: 1020ms
     - Wait safely: Until A explodes (480ms margin)

  2. After A explodes:
     - Only B remains
     - B still 1.5s left
     - Easy escape DOWN or sideways

Result: SUCCESS! ✅
```

### Scenario 3: Can't Use (Too Tight)

```
Bombs:
  A at [5,5]: 0.4s (TOO FAST!)
  B at [7,7]: 2.5s

Bot at [6,6]:
  - No time to reach safe position from A
  - Must use immediate escape or die

Staged Escape:
  Returns NULL (fastestBomb < 500ms)

Fallback: Traditional timing-optimized escape
```

---

## Integration into Escape Flow

### Priority Order

```
PHASE 1: Bomb Chain Detection
   ↓
PHASE 2: STAGED ESCAPE (NEW!)
   If viable → Path to waiting position
   ↓
PHASE 3: Path-based Escape
   Full BFS escape path
   ↓
PHASE 4: Timing-optimized Direction
   Single-step based on timing
   ↓
PHASE 5: Trap Detection + Evasive Action
   Last resort when trapped
   ↓
PHASE 6: STAY (Death)
```

### Code Integration

```javascript
// In attemptEscape()

if (bombs.length >= 2) {
  const gridPos = toGridCoords(player.x, player.y)
  const waitStrategy = findSafeWaitingPosition(gridPos, map, bombs, bombers, myUid)

  if (waitStrategy) {
    const waitPath = findBestPath(map, player, [waitStrategy.waitPosition], ...)

    if (waitPath) {
      return {
        action: waitPath.path[0],
        isEscape: true,
        fullPath: waitPath.path,
        isWaitingStrategy: true,  // Flag for special handling
        waitPosition: waitStrategy.waitPosition
      }
    }
  }
}
```

---

## Log Output

### When Strategy Activates

```
🔍 Staged Escape Analysis:
   Fastest bomb: [9, 10] explodes in 1.5s
   Remaining bombs: 1
      Bomb 1: [11, 12] explodes in 3.2s

   ✅ Safe waiting position found: [7, 12]
      Distance: 2 tiles (1.4s travel)
      Time until fast bomb explodes after arrival: 0.1s
      In remaining blast zones: NO (completely safe)

💡 STAGED ESCAPE STRATEGY AVAILABLE:
   Wait in completely safe zone while fast bomb explodes
   Move to [7, 12] and wait 0.1s
   ✅ Path to waiting position: LEFT → LEFT

🎯 DECISION: ESCAPE (staged - wait for fast bomb)
```

### When Strategy Not Viable

```
🔍 Staged Escape Analysis:
   Fastest bomb: [9, 10] explodes in 0.8s
   Remaining bombs: 2

   ❌ No safe waiting positions found
   (Reason: Not enough time to reach any safe position)
```

---

## Performance Considerations

### Computation Cost

- **Search radius**: Max 4 tiles (16 perimeter positions per radius)
- **Total positions checked**: ~100 max
- **Per position**:
  - Blast zone check: O(bombs)
  - Timing calculation: O(1)
  - Scoring: O(1)

**Total**: O(100 \* bombs) = **~300 operations** for 3 bombs

**Acceptable** - runs in < 5ms typically

### When to Skip

Skip staged escape if:

1. Only 1 bomb (no point)
2. Fastest bomb < 500ms (no time)
3. Fastest bomb > 2500ms (not urgent)
4. No search radius needed (already in good position)

---

## Edge Cases

### Edge Case 1: All Bombs Same Timing

```
Bombs: A (2.0s), B (2.0s), C (2.0s)

Result: No "fastest" bomb distinct enough
Action: Skip staged escape, use traditional escape
```

### Edge Case 2: Waiting Position Becomes Unsafe

```
Situation:
  - Move to waiting position [7, 12]
  - Enemy places NEW bomb near [7, 12]
  - Waiting position no longer safe!

Handling:
  - Next decision cycle will detect danger
  - Will trigger new escape (may abort waiting)
  - This is OK - strategy is adaptive
```

### Edge Case 3: Can't Escape After Waiting

```
Situation:
  - Wait for Bomb A to explode
  - Bomb A destroys wall that was blocking escape from B
  - But also creates new blocked area

Validation:
  - canEscapeAfterWaiting() checks this
  - If no escape after waiting → reject strategy
  - TODO: Implement full validation
```

---

## Future Enhancements

### 1. Multi-Stage Escape

```
Bombs: A (1s), B (2.5s), C (4s)

Current: Wait for A, then escape B+C together
Enhanced:
  Stage 1: Wait for A (1s)
  Stage 2: Wait for B (1.5s)
  Stage 3: Escape C only
```

### 2. Dynamic Waiting

```
Current: Calculate wait position once
Enhanced: Re-evaluate every frame while waiting
  - Adjust position if new bombs appear
  - Abort if waiting becomes unsafe
```

### 3. Terrain Prediction

```
Current: Don't consider what happens after bomb explodes
Enhanced:
  - Predict which walls/chests will be destroyed
  - Consider new walkable paths after explosion
  - Choose wait position that opens up best escape routes
```

### 4. Enemy Movement Prediction

```
Current: Static analysis
Enhanced:
  - Predict where enemy will be after fast bomb
  - Avoid waiting position enemy might bomb
  - Consider enemy's likely escape path
```

---

## Testing Checklist

- [ ] Single bomb → staged escape skipped
- [ ] Two bombs, good timing → staged escape used
- [ ] Two bombs, tight timing → fallback to traditional
- [ ] Waiting position completely safe → no further escape needed
- [ ] Waiting position in remaining blast → escape after wait
- [ ] Can't reach waiting position in time → reject strategy
- [ ] Enemy places bomb during wait → adaptive re-escape

---

## Summary

**Staged Escape** is a smart optimization for multi-bomb scenarios:

✅ **Pros**:

- Reduces complexity (n bombs → n-1 bombs)
- Better timing margins
- Improved terrain after explosion
- More strategic play

⚠️ **Cons**:

- Requires good timing calculation
- Adds decision complexity
- Risk if validation wrong

**When to use**:

- 2+ bombs with different timings
- Fastest bomb: 0.5s - 2.5s remaining
- Safe waiting position exists and reachable

**Best case scenario**:
Bot completely safe after moving, just waits for bomb to clear terrain, then has easy escape.

**Worst case scenario**:
Misjudged timing, bot dies while waiting. (But would likely die anyway in tight scenario)
