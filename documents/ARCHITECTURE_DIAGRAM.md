# 🏗️ Bomberman Bot - Architecture Diagram

## System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          BOMBERMAN BOT SYSTEM                               │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                              ENTRY POINT                                    │
│                            src/index.js                                     │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │  • WebSocket Connection Management                                 │    │
│  │  • Game State Management                                           │    │
│  │  • Bomb Tracking (bomberPassedThrough)                            │    │
│  │  • Manual/AI Mode Control                                          │    │
│  │  • Movement Execution System                                       │    │
│  └────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          DECISION ENGINE                                    │
│                   agent.js                                   │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │                    decideNextAction(state, myUid)                  │    │
│  │  ┌──────────────────────────────────────────────────────────────┐ │    │
│  │  │  Phase 0: Context Analysis (game phase, risk, strategy)      │ │    │
│  │  │  Phase 1: Safety Check & Escape                              │ │    │
│  │  │  Phase 1.5: Enemy Trap Detection                             │ │    │
│  │  │  Phase 1.6: Chain Reaction Detection                         │ │    │
│  │  │  Phase 2: Dynamic Item Prioritization                        │ │    │
│  │  │  Phase 3: Chest Bombing                                      │ │    │
│  │  │  Phase 4: Target Prioritization                              │ │    │
│  │  │  Phase 5: Enemy Pursuit                                      │ │    │
│  │  │  Phase 6: Exploration                                        │ │    │
│  │  └──────────────────────────────────────────────────────────────┘ │    │
│  └────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                    │                               │
                    ▼                               ▼
    ┌───────────────────────────┐     ┌───────────────────────────┐
    │   PATHFINDING MODULE      │     │    STRATEGY MODULE        │
    │  (Movement & Safety)      │     │  (Game Intelligence)      │
    └───────────────────────────┘     └───────────────────────────┘
```

---

## Pathfinding Module Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                      PATHFINDING MODULE                             │
│                    src/bot/pathfinding/                             │
└─────────────────────────────────────────────────────────────────────┘

┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│  pathFinder.js   │      │  dangerMap.js    │      │safetyEvaluator.js│
│                  │      │                  │      │                  │
│ • findBestPath   │◄────►│• findUnsafeTiles │◄────►│• isTileSafeByTime│
│ • findShortest   │      │• findSafeTiles   │      │  (timing logic)  │
│   EscapePath     │      │• createBombMap   │      │                  │
│                  │      │                  │      │                  │
│  Uses BFS to     │      │  Maps all bomb   │      │  Validates tile  │
│  find shortest   │      │  danger zones    │      │  safety with     │
│  paths avoiding  │      │  for O(1) lookup │      │  explosion time  │
│  danger zones    │      │                  │      │                  │
└──────────────────┘      └──────────────────┘      └──────────────────┘
         │                         │                          │
         └─────────────────────────┴──────────────────────────┘
                                   │
         ┌─────────────────────────┴──────────────────────────┐
         ▼                                                     ▼
┌──────────────────┐                              ┌──────────────────┐
│timingAnalyzer.js │                              │ riskEvaluator.js │
│                  │                              │                  │
│• calculateDanger │                              │• evaluatePosition│
│  Timeline        │                              │  Risk            │
│• findEscapeWindow│                              │• findSafest      │
│• findSafestTimed │                              │  NearbyPosition  │
│  Path            │                              │• wouldMoveTrapUs │
│                  │                              │                  │
│ Creates timeline │                              │  Scores position │
│ of when tiles    │                              │  risk based on   │
│ become dangerous │                              │  escape routes   │
└──────────────────┘                              └──────────────────┘

EXPORTS:
• findBestPath()           → Main pathfinding
• findShortestEscapePath() → Emergency escape
• findUnsafeTiles()        → Danger zone detection
• findSafeTiles()          → Safe position finding
• isTileSafeByTime()       → Timing validation
• calculateDangerTimeline()→ Explosion timeline
• evaluatePositionRisk()   → Risk scoring
```

---

## Strategy Module Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                       STRATEGY MODULE                               │
│                     src/bot/strategy/                               │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    TARGET & ESCAPE STRATEGIES                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐      │
│  │targetSelector  │  │escapeStrategy  │  │advancedEscape  │      │
│  │                │  │                │  │                │      │
│  │• findAllItems  │  │• attemptEscape │  │• findAdvanced  │      │
│  │• findAllChests │  │• attemptEmerg  │  │  EscapePath    │      │
│  │• findAllEnemies│  │  encyEscape    │  │• detectBomb    │      │
│  │• checkBombWould│  │• checkSafety   │  │  Chains        │      │
│  │  DestroyItems  │  │                │  │• findChainSafe │      │
│  │• countChests   │  │  3-tier escape │  │  Position      │      │
│  │  DestroyedBy   │  │  fallback      │  │                │      │
│  │  Bomb          │  │  system        │  │  Multi-bomb    │      │
│  └────────────────┘  └────────────────┘  └────────────────┘      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                    COMBAT & TRAP STRATEGIES                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐      │
│  │trapDetector    │  │threatAssessment│  │chainReaction   │      │
│  │                │  │                │  │                │      │
│  │• findTrap      │  │• scoreEnemy    │  │• calculateChain│      │
│  │  Opportunities │  │  Threat        │  │  ReactionValue │      │
│  │• isEnemyTrapped│  │• findMostThreat│  │• findChain     │      │
│  │                │  │  eningEnemy    │  │  Reaction      │      │
│  │  Detects when  │  │• findWeakest   │  │  Opportunities │      │
│  │  enemies are   │  │  Enemy         │  │• isChainReaction│     │
│  │  in corners/   │  │• shouldFight   │  │  Worthwhile    │      │
│  │  dead-ends     │  │  OrFlee        │  │                │      │
│  └────────────────┘  └────────────────┘  └────────────────┘      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                 DECISION SUPPORT STRATEGIES                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────┐      │
│  │priorityCalc    │  │enemyPredictor  │  │bombValidator   │      │
│  │                │  │                │  │                │      │
│  │• dynamicItem   │  │• predictEnemy  │  │• validateBomb  │      │
│  │  Priority      │  │  Positions     │  │  Safety        │      │
│  │• calculateRisk │  │• evaluatePath  │  │• findBestSafe  │      │
│  │  Tolerance     │  │  Danger        │  │  BombPosition  │      │
│  │• determineGame │  │• findPredictive│  │• canSafelyBomb │      │
│  │  Phase         │  │  BombPosition  │  │  CurrentPos    │      │
│  │                │  │                │  │                │      │
│  │  Adapts item   │  │  Simulates     │  │  Pre-validates │      │
│  │  values based  │  │  enemy moves   │  │  bomb placement│      │
│  │  on game state │  │  3 ticks ahead │  │  with escape   │      │
│  └────────────────┘  └────────────────┘  └────────────────┘      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────┐
│                   OPTIMIZATION STRATEGIES                           │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌────────────────┐  ┌────────────────┐                           │
│  │multiTargetPath │  │zoneControl     │                           │
│  │                │  │                │                           │
│  │• findMultiTarget│ │• evaluateZone  │                           │
│  │  Path          │  │  Control       │                           │
│  │• findOptimal   │  │• findSafeRetreat│                          │
│  │  ItemPath      │  │  Position      │                           │
│  │• compareSingle │  │• isInControlled│                           │
│  │  VsMultiTarget │  │  Territory     │                           │
│  │                │  │                │                           │
│  │  Collects 3-5  │  │  Divides map   │                           │
│  │  items in      │  │  into zones,   │                           │
│  │  optimal order │  │  scores safety │                           │
│  └────────────────┘  └────────────────┘                           │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Decision Flow Diagram

```
                    ┌─────────────────┐
                    │  GAME TICK      │
                    │  Event Received │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │ decideNextAction│
                    │   (state, myUid)│
                    └────────┬────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
    ┌─────────┐      ┌──────────────┐     ┌──────────┐
    │ Safety  │      │ Game Context │     │ Targets  │
    │  Check  │      │   Analysis   │     │ Finding  │
    └────┬────┘      └──────┬───────┘     └────┬─────┘
         │                  │                   │
         │                  │                   │
    [UNSAFE?]          [Phase, Risk,       [Items, Chests,
         │              Strategy]               Enemies]
         │                  │                   │
         └──────────┬───────┴───────────────────┘
                    │
                    ▼
         ┌──────────────────────┐
         │   PRIORITY DECISION  │
         └──────────────────────┘
                    │
    ┌───────────────┼───────────────┐
    │               │               │
    ▼               ▼               ▼
┌────────┐    ┌──────────┐    ┌─────────┐
│ ESCAPE │    │ ATTACK   │    │COLLECT  │
│        │    │          │    │         │
│ • Chain│    │ • Trap   │    │ • Items │
│   Aware│    │   Enemy  │    │ • Chests│
│ • Timing│   │ • Chain  │    │ • Multi │
│ • Risk │    │   React  │    │   Path  │
└────┬───┘    └────┬─────┘    └────┬────┘
     │             │               │
     └─────────────┼───────────────┘
                   │
                   ▼
         ┌─────────────────┐
         │  VALIDATE ACTION│
         │                 │
         │ • Bomb Safety   │
         │ • Trap Check    │
         │ • Item Check    │
         └────────┬────────┘
                  │
                  ▼
         ┌─────────────────┐
         │ EXECUTE ACTION  │
         │                 │
         │ UP/DOWN/LEFT/   │
         │ RIGHT/BOMB/STAY │
         └─────────────────┘
```

---

## Data Flow Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                         GAME SERVER                                  │
│                    (WebSocket Events)                                │
└───────────────────────────┬──────────────────────────────────────────┘
                            │
                ┌───────────┼───────────┐
                │           │           │
                ▼           ▼           ▼
           ┌────────┐  ┌────────┐  ┌────────┐
           │  user  │  │  tick  │  │new_bomb│
           │        │  │        │  │        │
           │Initial │  │Every   │  │Bomb    │
           │State   │  │20ms    │  │Placed  │
           └───┬────┘  └───┬────┘  └───┬────┘
               │           │           │
               └───────────┼───────────┘
                           │
                           ▼
                 ┌──────────────────┐
                 │  STATE MANAGER   │
                 │   (index.js)     │
                 │                  │
                 │ • currentState   │
                 │ • bombTracking   │
                 │ • myUid          │
                 └────────┬─────────┘
                          │
                          ▼
                 ┌──────────────────┐
                 │  DECISION ENGINE │
                 │                  │
                 │ decideNextAction │
                 └────────┬─────────┘
                          │
         ┌────────────────┼────────────────┐
         │                │                │
         ▼                ▼                ▼
    ┌─────────┐     ┌─────────┐     ┌─────────┐
    │Pathfind │     │Strategy │     │  Utils  │
    │ Module  │     │ Module  │     │         │
    └────┬────┘     └────┬────┘     └────┬────┘
         │               │               │
         └───────────────┼───────────────┘
                         │
                         ▼
                  ┌────────────┐
                  │   ACTION   │
                  │            │
                  │ "UP"/"DOWN"│
                  │ "LEFT"/"..." │
                  └──────┬─────┘
                         │
                         ▼
                  ┌────────────┐
                  │  MOVEMENT  │
                  │  EXECUTOR  │
                  │            │
                  │ • Smooth   │
                  │ • Aligned  │
                  └──────┬─────┘
                         │
                         ▼
                 ┌───────────────┐
                 │  SEND TO      │
                 │  SERVER       │
                 │               │
                 │socket.emit()  │
                 └───────────────┘
```

---

## Module Dependency Graph

```
                         index.js
                             │
                ┌────────────┼────────────┐
                │            │            │
                ▼            ▼            ▼
        SocketManager  bomberman_   constants
                       beam_agent
                             │
                ┌────────────┼────────────┐
                │                         │
                ▼                         ▼
          pathfinding/              strategy/
                │                         │
    ┌───────────┼───────────┐   ┌────────┼────────┐
    │           │           │   │        │        │
    ▼           ▼           ▼   ▼        ▼        ▼
pathFinder  dangerMap  safety  target  escape  trap
                       Eval    Selector Strategy Detector
    │           │           │   │        │        │
    ▼           ▼           ▼   ▼        ▼        ▼
timing      risk       bomb   priority enemy   chain
Analyzer    Eval       Valid  Calculator Pred  Reaction
                                         │
                                         ▼
                                    multiTarget
                                         │
                                         ▼
                                    zoneControl
                                         │
                                         ▼
                                    advanced
                                    Escape
                                         │
                        ┌────────────────┼────────────────┐
                        │                                 │
                        ▼                                 ▼
                   gridUtils                         constants
```

---

## State Management Flow

```
┌─────────────────────────────────────────────────────────────┐
│                     GAME STATE                              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  currentState = {                                           │
│    map: [                                                   │
│      ["W", "W", "W", ...],  // 2D array of cells           │
│      ["W", ".", "C", ...],                                  │
│      ...                                                    │
│    ],                                                       │
│    bombs: [                                                 │
│      {                                                      │
│        x: 120, y: 160,        // Pixel coordinates         │
│        uid: "player123",      // Owner                     │
│        lifeTime: 5000,        // Time to explosion         │
│        createdAt: 1635...,    // Timestamp                 │
│        isExploded: false,     // State                     │
│        bomberPassedThrough: false // Tracked client-side   │
│      }                                                      │
│    ],                                                       │
│    bombers: [                                               │
│      {                                                      │
│        uid: "player123",                                    │
│        x: 100, y: 100,        // Pixel coordinates         │
│        isAlive: true,                                       │
│        bombCount: 2,          // Available bombs           │
│        explosionRange: 3,     // Bomb power                │
│        speed: 1.5             // Movement speed            │
│      }                                                      │
│    ]                                                        │
│  }                                                          │
│                                                             │
│  myUid = "player123"                                        │
│                                                             │
│  bombTracking = Map {                                       │
│    "bomb_id_1" => { gridX: 3, gridY: 4, bomberUid: "..." } │
│  }                                                          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Timing & Performance

```
┌─────────────────────────────────────────────────────────────┐
│                   PERFORMANCE TIMELINE                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Server Tick (every 20ms)                                   │
│     │                                                       │
│     ├─► Receive game state (0-5ms network latency)         │
│     │                                                       │
│     ├─► Execute decideNextAction()                          │
│     │   ├─ Phase 0: Context (1ms)                          │
│     │   ├─ Phase 1: Safety (2-3ms)                         │
│     │   ├─ Phase 2: Items (2-3ms)                          │
│     │   ├─ Phase 3: Chests (1-2ms)                         │
│     │   └─ Total: 5-15ms                                   │
│     │                                                       │
│     ├─► Send action to server (0-5ms network)              │
│     │                                                       │
│     └─► Wait for next tick                                 │
│                                                             │
│  Total Cycle Time: 20ms (server controlled)                │
│  Bot Processing: 5-15ms (well within budget)               │
│  Network: 0-10ms (depends on connection)                   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Error Handling & Fallbacks

```
┌─────────────────────────────────────────────────────────────┐
│                    SAFETY MECHANISMS                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. Escape Priority                                         │
│     ├─ ALWAYS check safety first                           │
│     ├─ 3-tier escape fallback                              │
│     └─ Anti-oscillation tracking                           │
│                                                             │
│  2. Bomb Validation                                         │
│     ├─ Pre-validate escape before bombing                  │
│     ├─ Check item destruction                              │
│     └─ Verify safe tiles exist                             │
│                                                             │
│  3. Position Risk                                           │
│     ├─ Evaluate before moving                              │
│     ├─ Avoid dead-ends                                     │
│     └─ Check trap conditions                               │
│                                                             │
│  4. Timing Safety                                           │
│     ├─ 200ms buffer on explosions                          │
│     ├─ Account for network latency                         │
│     └─ Validate time calculations                          │
│                                                             │
│  5. Fallback Actions                                        │
│     └─ If all else fails: "STAY"                           │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

**Document Version:** 2.0  
**Architecture Type:** Modular, Event-Driven, AI Decision System  
**Design Patterns:** Strategy, Observer, State Management  
**Last Updated:** October 24, 2025
