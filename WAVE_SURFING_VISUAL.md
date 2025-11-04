# Wave Surfing Visual Guide

## Concept Visualization

### Basic Wave Expansion

```
Time: 0ms (Bomb placed)
┌─────────────────┐
│ . . . . . . . . │
│ . . . . . . . . │
│ . . . . . . . . │
│ . . . . . . . . │
│ . . . 💣 . . . . │  💣 = Bomb (will explode in 3000ms)
│ . . . . . . . . │
│ . . . . . . . . │
│ . . . . . . . . │
└─────────────────┘

Time: 2800ms (200ms before explosion)
┌─────────────────┐
│ . . . . . . . . │
│ . . . 🟡 . . . . │  🟡 = Wave edge (safe surfing position)
│ . . 🟡 . 🟡 . . . │  ⚠️ = Danger zone (will be hit by wave)
│ . . . ⚠️ . . . . │  💣 = Bomb (200ms to explosion)
│ . 🟡 ⚠️ 💣 ⚠️ 🟡 . . │
│ . . . ⚠️ . . . . │
│ . . 🟡 . 🟡 . . . │
│ . . . 🟡 . . . . │
└─────────────────┘

Time: 3000ms (Explosion starts)
┌─────────────────┐
│ . . . . . . . . │
│ . . . 🟢 . . . . │  💥 = Exploding
│ . . 🟡 💥 🟡 . . . │  🟢 = Safe (wave just arrived at neighbors)
│ . . . 💥 . . . . │  🟡 = New wave edges
│ . 🟡 💥 💥 💥 🟡 . . │
│ . . . 💥 . . . . │
│ . . 🟡 💥 🟡 . . . │
│ . . . 🟢 . . . . │
└─────────────────┘

Time: 3040ms (Wave expanding - 1 tile propagation)
┌─────────────────┐
│ . . . 🟡 . . . . │  💥 = Currently exploding
│ . . 🟡 💥 🟡 . . . │  🟡 = Safe surfing edges
│ . 🟡 💥 💥 💥 🟡 . . │  🟢 = Safe (wave passed)
│ . . 💥 💥 💥 . . . │
│ 🟡 💥 💥 💥 💥 💥 🟡 . │
│ . . 💥 💥 💥 . . . │
│ . 🟡 💥 💥 💥 🟡 . . │
│ . . 🟡 💥 🟡 . . . │
└─────────────────┘
```

## Multi-Wave Surfing Example

### Scenario: Two Bombs with Different Timings

```
Initial State (t=0ms)
┌─────────────────┐
│ . . . . . . . . │
│ . . . . . . . . │
│ . . 💣A . . 💣B . . │  💣A = Fast bomb (2000ms)
│ . . . . . . . . │  💣B = Slow bomb (3500ms)
│ . . . . . . . . │  🤖 = Bot position
│ . 🤖 . . . . . . │
│ . . . . . . . . │
│ . . . . . . . . │
└─────────────────┘

Bot Decision (t=100ms)
┌─────────────────┐
│ . . . . . . . . │
│ . . ⚠️A . . ⚠️B . . │  ⚠️A = Fast wave danger zone
│ . . 💣A . . 💣B . . │  ⚠️B = Slow wave danger zone
│ . . ⚠️A . . ⚠️B . . │  🟡 = OPTIMAL surfing position
│ . . . . 🟡 . . . │      (safe from A, in B's zone but timed)
│ . 🤖→ . . . . . . │  🤖→ = Bot moving to surf position
│ . . . . . . . . │
│ . . . . . . . . │
└─────────────────┘

Wave Surfing (t=1800ms)
┌─────────────────┐
│ . . . . . . . . │
│ . . ⚠️A . . ⚠️B . . │  Bot successfully moved to [4,4]
│ . . 💣A . . 💣B . . │  Safe from fast bomb A (200ms margin)
│ . . ⚠️A . . ⚠️B . . │  Still has 1700ms before slow bomb B
│ . . . . 🤖 . . . │  After A explodes, can escape from B
│ . . . . . . . . │
│ . . . . . . . . │
│ . . . . . . . . │
└─────────────────┘

After First Wave (t=2100ms)
┌─────────────────┐
│ . . . . . . . . │
│ . . 💥A . . ⚠️B . . │  💥A = Bomb A exploded
│ . . 💥A . . 💣B . . │  Bot survived by surfing!
│ . . 💥A . . ⚠️B . . │  Now escaping from B
│ . . . . . 🤖→ . . │  🤖→ = Moving to final safety
│ . . . . . . . . │
│ . . . . . . . . │
│ . . . . . . . . │
└─────────────────┘
```

## Complex Multi-Wave Corridor

### Scenario: Navigating Through 4 Overlapping Bombs

```
Initial Chaos (t=0ms)
┌─────────────────┐
│ . . . . . . . . │
│ . 💣1 . . . 💣2 . . │  💣1 = 2.0s
│ . . . . . . . . │  💣2 = 2.5s
│ . . . . . . . . │  💣3 = 3.0s
│ 🤖 . . . . . . . │  💣4 = 3.5s
│ . . . . . . . . │  🤖 = Bot must escape!
│ . 💣3 . . . 💣4 . . │
│ . . . . . . . . │
└─────────────────┘

Wave Surfing Corridor (t=500ms)
┌─────────────────┐
│ . . 🟡 . . . . . │  🟡 = Safe surfing corridor
│ . ⚠️1 🟡 🟡 . ⚠️2 . . │  Bot navigates through narrow
│ . ⚠️1 . 🟡 . ⚠️2 . . │  timing window between waves
│ . . . 🤖→🟡 . . . │
│ . ⚠️3 🟡 . . ⚠️4 . . │  Strategy: Move right through
│ . ⚠️3 . . . ⚠️4 . . │  corridor, then up to safety
│ . ⚠️3 . . . ⚠️4 . . │
│ . . . . . . . . │
└─────────────────┘

Successful Surf (t=1800ms)
┌─────────────────┐
│ . . . 🤖 . . . . │  ✓ Bot reached safety!
│ . ⚠️1 . . . ⚠️2 . . │  Surfed through 4 overlapping
│ . ⚠️1 . . . ⚠️2 . . │  waves using precise timing
│ . . . . . . . . │
│ . ⚠️3 . . . ⚠️4 . . │  All bombs still dangerous but
│ . ⚠️3 . . . ⚠️4 . . │  bot is in safe zone!
│ . ⚠️3 . . . ⚠️4 . . │
│ . . . . . . . . │
└─────────────────┘
```

## Wave Edge Scoring Visualization

```
Single Bomb Wave Edge Analysis
┌─────────────────┐
│ . . . . . . . . │
│ . . 5️⃣ 3️⃣ 5️⃣ . . . │  Numbers = Surfing scores
│ . 5️⃣ 2️⃣ ⚠️ 2️⃣ 5️⃣ . . │  Higher = better position
│ . 3️⃣ ⚠️ 💣 ⚠️ 3️⃣ . . │
│ . 5️⃣ 2️⃣ ⚠️ 2️⃣ 5️⃣ . . │  Best: [2,1] and [6,1] etc
│ . . 5️⃣ 3️⃣ 5️⃣ . . . │  Good: Multiple escape routes
│ . . . . . . . . │  Poor: Close to danger, few exits
│ 🤖 . . . . . . . │
└─────────────────┘

Score Factors:
1️⃣ Far from bomb + good timing     = 5000 pts
2️⃣ Medium distance                 = 3000 pts
3️⃣ Close but multiple escape routes = 2500 pts
```

## Timing Precision Example

```
Wave Propagation Timeline (40ms per tile)
┌─────────────────┐
│                 │
│     3160ms      │  Distance 4: Wave arrives at 3160ms
│       ↓         │  Distance 3: Wave arrives at 3120ms
│     3120ms      │  Distance 2: Wave arrives at 3080ms
│       ↓         │  Distance 1: Wave arrives at 3040ms
│     3080ms      │  Distance 0: Wave arrives at 3000ms
│       ↓         │
│     3040ms      │  Explosion spreads from center
│       ↓         │  at 40ms per tile (1 grid)
│  💣 3000ms 🤖    │
│                 │  Bot at distance 4 must arrive
│                 │  before 3160ms to safely surf!
└─────────────────┘

Surfing Window Calculation:
- Bomb explodes at: 3000ms
- Wave reaches [4,0] at: 3000 + (4 × 40) = 3160ms
- Bot travel time (4 tiles): 4 × 680ms = 2720ms
- Surfing window: 3160 - 2720 = 440ms ✓ SAFE
```

## Strategy Comparison

### Traditional Escape vs Wave Surfing

```
Traditional: "Run to nearest safe tile"
┌─────────────────┐
│ . . . . . . . . │
│ . 💣A . . . 💣B . . │
│ . . . . . . . . │  Traditional escape finds
│ . . . . . . . . │  nearest COMPLETELY safe tile
│ 🤖→ . . . . . . . │  = [0,4] (far left)
│ . . . . . . . . │
│ . . . . . . . . │  Distance: 4 tiles
│ . . . . . . . . │  Result: SLOW, may not reach
└─────────────────┘

Wave Surfing: "Navigate wave edges strategically"
┌─────────────────┐
│ . . . . . . . . │
│ . 💣A . 🎯 . 💣B . . │  🎯 = Surfing position
│ . . . . ↑ . . . │      (closer, timed perfectly)
│ . . . . ↑ . . . │
│ 🤖→ → → → . . . . │  Distance: 4 tiles (same)
│ . . . . . . . . │  Result: STRATEGIC position
│ . . . . . . . . │          between waves!
│ . . . . . . . . │
└─────────────────┘

Outcome:
Traditional: May timeout reaching distant safe tile
Wave Surfing: Reaches closer strategic position, then escapes after wave passes
```

## Legend

```
🤖 = Bot (your position)
💣 = Bomb (active, will explode)
💥 = Explosion (currently happening)
⚠️  = Danger zone (will be hit by wave)
🟡 = Wave edge (optimal surfing position)
🟢 = Safe zone (wave has passed)
🎯 = Target surfing position
→  = Movement direction
```

## Key Takeaways

1. **Wave edges are safer than static positions** - Stay mobile, surf the danger
2. **Timing > Distance** - A closer timed position beats a farther safe one
3. **Multi-wave corridors exist** - Navigate between overlapping waves
4. **Precision matters** - 40ms per tile granularity enables tight maneuvers
5. **Escape routes matter** - Always have multiple exits from surfing position
