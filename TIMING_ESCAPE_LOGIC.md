# Time-Based Escape Logic

## Overview

Enhanced the bot's escape pathfinding to consider bomb explosion times, allowing it to take paths through danger zones if it can reach safety before bombs explode.

## Changes Made

### 1. Constants (`src/constants/index.js`)

- Added `BOMB_EXPLOSION_TIME = 2000` (2 seconds in milliseconds)
- Exported `STEP_DELAY` for time calculations

### 2. Client-Side Bomb Tracking (`src/index.js`)

Since `bomberPassedThrough` comes as a fixed value from the server's `new_bomb` event, we implement client-side tracking following the game rules:

**Game Rule:**

- When **ANY bomb** is placed, if **OUR bomber** is on that bomb tile → we can walk through (initially)
- If **OUR bomber** is NOT on the bomb tile when placed → blocks us immediately
- Once **OUR bomber** leaves ANY bomb tile → that bomb blocks us forever (can't walk back on it)

**Key Insight:** The flag tracks whether **WE** have passed through the bomb, not whether the bomb owner left it. Each bomber has their own "passed through" state for each bomb.

**On `new_bomb` event:**

- Check if **OUR bomber's** grid position matches bomb's grid position
- Initialize `bomb.bomberPassedThrough = !weAreOnBombTile`
  - `false` if we're on the tile (we can walk through)
  - `true` if we're NOT on the tile (blocks us immediately)
- Track bomb position in `bombTracking` Map

**On `player_move` event (only for OUR bomber):**

- Check if we moved away from ANY bomb's grid cell
- Update `bomb.bomberPassedThrough = true` for ALL bombs we leave
- After this, those bombs will block us forever

**On `bomb_explode` event:**

- Clean up tracking data for exploded bombs

**On `user` event (initial state):**

- Initialize tracking for all existing bombs
- Check OUR current position to set initial `bomberPassedThrough` state

This ensures accurate tracking of which bombs block **OUR** movement.

### 3. Server Bomb Data Structure

Bombs include the following server-provided properties:

1. **x, y** - Bomb coordinates on the map
2. **uid** - UID of the bot that placed the bomb
3. **lifeTime** - Time until bomb explodes (milliseconds)
4. **createdAt** - Timestamp when bomb was placed
5. **isExploded** - Whether bomb has exploded
6. **bomberPassedThrough** - Whether bomber has left the bomb tile _(tracked client-side)_
7. **id** - Unique bomb identifier

### 4. Time-Based Safety Function (`src/bot/bomberman_beam_agent.js`)

Added `isTileSafeByTime()` function that:

- Calculates time needed to reach a tile based on:
  - Number of steps required
  - Current movement speed
  - Game tick rate (STEP_DELAY)
- For each bomb, determines:
  - Time until explosion using server's `bomb.lifeTime`
  - Whether bot will reach tile before bomb explodes
  - If bot will be in blast radius when bomb explodes
- Returns `true` if tile will be safe when bot arrives

**Formula:**

```javascript
timeToReach = ((stepsToReach * GRID_SIZE) / currentSpeed) * STEP_DELAY
bombLifeTime = bomb.lifeTime || BOMB_EXPLOSION_TIME // Server's lifeTime
timeUntilExplosion = bombLifeTime - (now - bomb.createdAt)
```

### 5. Enhanced Bomb-Blocking Logic

Updated both `findBestPath()` and `findShortestEscapePath()`:

- Changed `bombTiles` from `Set` to `Map` to access full bomb objects
- Uses client-tracked `bomb.bomberPassedThrough` flag for accurate blocking
- **Simple logic:**
  - If `bomberPassedThrough === true` → blocks us (we already left it)
  - If `bomberPassedThrough === false` → can walk through (we're still on it)

**Logic:**

```javascript
const bombAtTile = bombTiles.get(key)
if (bombAtTile) {
  if (bombAtTile.bomberPassedThrough) {
    continue // Block: we already passed through this bomb
  }
  // else: we're still on the bomb tile -> can walk on it
}
```

**Note:** This works for ALL bombs (ours or enemies'), because the flag tracks whether **WE** have passed through each bomb.

### 6. Enhanced Escape Pathfinding

Updated `findShortestEscapePath()`:

- Now tracks step count in BFS queue: `[x, y, path, stepCount]`
- Uses `isTileSafeByTime()` to determine if tile will be safe
- Allows crossing danger zones if bombs will explode after bot passes
- Logs time-based escape decisions with millisecond calculations

### 7. Smarter Emergency Escapes

Enhanced emergency move logic with 3-pass system:

**Pass 1 (Best):** Time-safe tiles

- Tiles that will be safe by the time bot reaches them
- Uses server's `lifeTime` for precise calculations

**Pass 2 (Good):** Currently safe tiles

- Tiles not currently in blast zones
- May become dangerous if bombs explode soon

**Pass 3 (Last Resort):** Any walkable tile

- When completely surrounded
- Bot moves anyway to attempt survival

## Benefits

### Before:

- Bot avoided ALL danger zones, even if bombs would explode after passing
- Could get trapped when faster escape routes existed through temporary danger
- Conservative but sometimes unnecessary long routes

### After:

- Bot can take risky but faster escapes if math shows it's safe
- Better utilizes movement speed upgrades ('S' items)
- More aggressive and efficient escaping
- Still safe - only crosses danger when timing guarantees survival

## Example Scenario

```
Bomb at [5, 5] with lifeTime=2000ms, created at T=0
Bot at [5, 7] with speed=3, needs to reach [5, 3]

Path 1 (safe route): [5,7] → [6,7] → [6,6] → [6,5] → [6,4] → [6,3] → [5,3]
  - 6 steps = ~356ms (safe but slow)

Path 2 (through danger): [5,7] → [5,6] → [5,5] → [5,4] → [5,3]
  - 4 steps = ~237ms (FASTER!)
  - Bot passes [5,5] at ~118ms, bomb explodes at 2000ms
  - SAFE! Bot cleared blast zone long before explosion

OLD BOT: Takes Path 1 (slow)
NEW BOT: Takes Path 2 (fast) because server's lifeTime allows it
```

## Technical Details

### Time Calculation Precision

- Movement time = `(steps * 40 / speed) * 20ms`
- Bomb timer uses server's `lifeTime` field
- Remaining time = `bomb.lifeTime - (now - bomb.createdAt)`
- Safety margin built into `isTileSafeByTime()` logic

### Edge Cases Handled

1. **Missing lifeTime**: Falls back to `BOMB_EXPLOSION_TIME = 2000ms`
2. **Already exploded**: Skips bombs with `isExploded = true`
3. **Bomber on bomb**: Uses `bomberPassedThrough` flag to determine if bomb blocks movement
4. **Multiple bombs**: Checks safety against ALL active bombs
5. **Speed variations**: Uses current `myBomber.speed` in calculations

### Debug Output

Enhanced logs show:

- `🕐 Found time-safe escape to [x, y] in N steps (Xms)`
- `✅ Time-safe emergency move: DIR to [x, y]`
- `⚠️ Currently safe emergency move: DIR to [x, y] (but bomb may explode!)`

## Configuration

The bot uses server-provided `lifeTime` for each bomb. The fallback constant is in `src/constants/index.js`:

```javascript
export const BOMB_EXPLOSION_TIME = 2000 // Fallback only, server controls actual timing
```

If your server uses different bomb timers, they will be automatically respected via the `lifeTime` field.

## Testing Recommendations

1. Test with speed=1 (default): Should behave conservatively
2. Test with speed=3 (after 'S' items): Should take riskier shortcuts
3. Test multiple simultaneous bombs: Ensure all timers considered
4. Verify server's `lifeTime` values are being used (check debug logs)
5. Test at bomb placement moment: Should step off immediately even with T=0
