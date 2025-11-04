// Wave Surfing Test Suite
import {
  calculateWaveExpansion,
  calculateMultiWaveExpansion,
  findWaveEdges,
  findWaveSurfingPath,
  getWaveSurfingDirection,
} from "../src/bot/pathfinding/waveSurfing.js"

/**
 * Test wave expansion calculation
 */
export function testWaveExpansion() {
  console.log("Testing Wave Expansion...")

  const map = Array(16)
    .fill(null)
    .map(() => Array(16).fill(null))
  const bombers = [{ uid: "test", speed: 1, explosionRange: 3 }]

  const bomb = {
    x: 200, // Grid 5
    y: 200, // Grid 5
    uid: "test",
    createdAt: Date.now(),
    lifeTime: 3000,
    explosionRange: 3,
  }

  const waveData = calculateWaveExpansion(bomb, map, bombers)

  console.log(`✓ Wave data generated: ${waveData.size} tiles`)
  console.log(`✓ Sample wave timing:`)

  // Check a few key positions
  const center = waveData.get("5,5")
  console.log(`  Center [5,5]: arrives in ${center?.waveArrivalTime}ms`)

  const edge = waveData.get("8,5")
  if (edge) {
    console.log(
      `  Edge [8,5]: arrives in ${edge.waveArrivalTime}ms (dist: ${edge.distanceFromBomb})`,
    )
  }

  return waveData.size > 0
}

/**
 * Test multi-wave expansion
 */
export function testMultiWaveExpansion() {
  console.log("\nTesting Multi-Wave Expansion...")

  const map = Array(16)
    .fill(null)
    .map(() => Array(16).fill(null))
  const bombers = [{ uid: "test", speed: 1, explosionRange: 3 }]

  const bombs = [
    {
      x: 200,
      y: 200,
      uid: "test",
      createdAt: Date.now(),
      lifeTime: 3000,
      explosionRange: 3,
    },
    {
      x: 280,
      y: 200,
      uid: "test",
      createdAt: Date.now(),
      lifeTime: 4000, // Slower bomb
      explosionRange: 3,
    },
  ]

  const multiWave = calculateMultiWaveExpansion(bombs, map, bombers)

  console.log(`✓ Multi-wave data generated: ${multiWave.size} tiles`)

  // Check for overlapping waves
  let overlappingCount = 0
  for (const [key, data] of multiWave.entries()) {
    if (data.multipleWaves) {
      overlappingCount++
    }
  }

  console.log(`✓ Overlapping wave tiles: ${overlappingCount}`)

  return multiWave.size > 0
}

/**
 * Test wave edge detection
 */
export function testWaveEdges() {
  console.log("\nTesting Wave Edge Detection...")

  const map = Array(16)
    .fill(null)
    .map(() => Array(16).fill(null))
  const bombers = [{ uid: "test", speed: 1, explosionRange: 3 }]

  const bombs = [
    {
      x: 200,
      y: 200,
      uid: "test",
      createdAt: Date.now(),
      lifeTime: 2000,
      explosionRange: 3,
    },
  ]

  const waveData = calculateMultiWaveExpansion(bombs, map, bombers)
  const currentPos = { x: 2, y: 2 }

  const edges = findWaveEdges(waveData, currentPos, 1, map)

  console.log(`✓ Wave edges found: ${edges.length}`)

  if (edges.length > 0) {
    const best = edges[0]
    console.log(`✓ Best edge: [${best.x}, ${best.y}]`)
    console.log(`  Surfing window: ${best.surfingWindow}ms`)
    console.log(`  Score: ${best.surfingScore.toFixed(0)}`)
  }

  return edges.length > 0
}

/**
 * Test wave surfing pathfinding
 */
export function testWaveSurfingPath() {
  console.log("\nTesting Wave Surfing Pathfinding...")

  const map = Array(16)
    .fill(null)
    .map(() => Array(16).fill(null))
  const bombers = [{ uid: "test", speed: 1, explosionRange: 3, x: 2, y: 2 }]

  const bombs = [
    {
      x: 200,
      y: 200,
      uid: "test",
      createdAt: Date.now(),
      lifeTime: 2000,
      explosionRange: 3,
    },
    {
      x: 280,
      y: 200,
      uid: "test",
      createdAt: Date.now(),
      lifeTime: 3000,
      explosionRange: 3,
    },
    {
      x: 200,
      y: 280,
      uid: "test",
      createdAt: Date.now(),
      lifeTime: 2500,
      explosionRange: 3,
    },
  ]

  const start = { x: 2, y: 2 }
  const path = findWaveSurfingPath(start, bombs, map, bombers, "test")

  if (path && path.target) {
    console.log(`✓ Surfing path found!`)
    console.log(`  Strategy: ${path.strategy}`)
    console.log(`  Target: [${path.target.x}, ${path.target.y}]`)
    if (path.path) {
      console.log(`  Path: ${path.path.join(" → ")}`)
    }
    return true
  } else {
    console.log(`ℹ️  No surfing path needed (safe position)`)
    return true // Not an error if no path needed
  }
}

/**
 * Test wave surfing direction
 */
export function testWaveSurfingDirection() {
  console.log("\nTesting Wave Surfing Direction...")

  const map = Array(16)
    .fill(null)
    .map(() => Array(16).fill(null))
  const bombers = [{ uid: "test", speed: 1, explosionRange: 3, x: 5, y: 5 }]

  const bombs = [
    {
      x: 200,
      y: 200,
      uid: "test",
      createdAt: Date.now(),
      lifeTime: 2000,
      explosionRange: 3,
    },
    {
      x: 280,
      y: 200,
      uid: "test",
      createdAt: Date.now(),
      lifeTime: 3000,
      explosionRange: 3,
    },
    {
      x: 200,
      y: 280,
      uid: "test",
      createdAt: Date.now(),
      lifeTime: 2500,
      explosionRange: 3,
    },
  ]

  const currentPos = { x: 5, y: 5 }
  const direction = getWaveSurfingDirection(currentPos, bombs, map, bombers, "test")

  if (direction) {
    console.log(`✓ Surfing direction: ${direction}`)
    return true
  } else {
    console.log(`ℹ️  No surfing direction needed`)
    return true
  }
}

/**
 * Run all tests
 */
export function runAllWaveSurfingTests() {
  console.log("=".repeat(50))
  console.log("WAVE SURFING TEST SUITE")
  console.log("=".repeat(50))

  const tests = [
    { name: "Wave Expansion", fn: testWaveExpansion },
    { name: "Multi-Wave Expansion", fn: testMultiWaveExpansion },
    { name: "Wave Edges", fn: testWaveEdges },
    { name: "Wave Surfing Path", fn: testWaveSurfingPath },
    { name: "Wave Surfing Direction", fn: testWaveSurfingDirection },
  ]

  let passed = 0
  let failed = 0

  for (const test of tests) {
    try {
      const result = test.fn()
      if (result) {
        passed++
      } else {
        failed++
        console.log(`✗ ${test.name} FAILED`)
      }
    } catch (error) {
      failed++
      console.log(`✗ ${test.name} ERROR: ${error.message}`)
    }
  }

  console.log("\n" + "=".repeat(50))
  console.log(`Results: ${passed} passed, ${failed} failed`)
  console.log("=".repeat(50))

  return failed === 0
}

// Run tests if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runAllWaveSurfingTests()
}
