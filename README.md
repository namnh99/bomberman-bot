# bomberman-bot

An advanced AI bot for playing Bomberman with sophisticated pathfinding, escape strategies, and **Wave Surfing** technology.

## Features

### 🌊 Wave Surfing (NEW!)

- **Full wave expansion tracking** - Calculates blast waves expanding at 40ms per tile
- **Wave edge detection** - Identifies optimal surfing positions just ahead of danger
- **Multi-wave navigation** - Coordinates movement across multiple overlapping bombs
- **Surfing corridors** - Finds safe paths through complex bomb patterns
- **Emergency surfing** - Escapes from danger by riding wave edges

See [WAVE_SURFING.md](./WAVE_SURFING.md) for technical details and [WAVE_SURFING_VISUAL.md](./WAVE_SURFING_VISUAL.md) for visual examples.

### 🧠 Advanced AI Strategies

- **Staged Escape** - Waits for fast bombs to explode before escaping slower ones
- **Timing-based Navigation** - Crosses danger zones with precise timing
- **Chain Reaction Detection** - Predicts bomb chain explosions
- **Anti-trap Strategy** - Avoids getting cornered by enemies
- **Zone Control** - Controls strategic map areas

### 🎯 Pathfinding

- **A\* Algorithm** with timing validation
- **Safety Evaluator** with speed-adaptive buffers
- **Escape Direction Selector** with Wave Surfing integration
- **Risk Evaluator** for bomb placement decisions

## Quick Start

```bash
npm install
npm start
```

## Wave Surfing Integration

Wave Surfing activates automatically in multi-bomb scenarios:

- **3+ bombs**: Escape direction selector uses Wave Surfing
- **4+ bombs**: Advanced escape uses Wave Surfing pathfinding

## Testing

Run Wave Surfing tests:

```bash
node tests/waveSurfing.test.js
```

## Project Structure

```
src/
├── bot/
│   ├── pathfinding/
│   │   ├── waveSurfing.js      ← NEW! Full Wave Surfing implementation
│   │   ├── escapeDirectionSelector.js (Wave Surfing integrated)
│   │   ├── pathFinder.js
│   │   ├── safetyEvaluator.js
│   │   └── ...
│   └── strategy/
│       ├── advancedEscape.js    (Wave Surfing integrated)
│       ├── stagedEscape.js
│       └── ...
├── utils/
└── handlers/

WAVE_SURFING.md                  ← NEW! Technical documentation
WAVE_SURFING_VISUAL.md           ← NEW! Visual guide
```

## Performance

- Wave Surfing executes in < 5ms for most scenarios
- Handles 10+ simultaneous bombs efficiently
- Real-time decision making suitable for competitive play

## License

MIT
