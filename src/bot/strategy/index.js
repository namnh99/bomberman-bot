export {
  findAllItems,
  findAllChests,
  findAllEnemies,
  checkBombWouldDestroyItems,
  countChestsDestroyedByBomb,
  willBombHitEnemy,
} from "./targetSelector.js"

export { checkSafety, attemptEscape, attemptEmergencyEscape } from "./escapeStrategy.js"

export { findTrapOpportunities, isEnemyTrapped } from "./trapDetector.js"

export {
  dynamicItemPriority,
  calculateRiskTolerance,
  determineGamePhase,
} from "./priorityCalculator.js"

export {
  predictEnemyPositions,
  evaluatePathDanger,
  findPredictiveBombPosition,
} from "./enemyPredictor.js"

export {
  calculateChainReactionValue,
  findChainReactionOpportunities,
  isChainReactionWorthwhile,
} from "./chainReaction.js"

export {
  evaluateZoneControl,
  findSafeRetreatPosition,
  isInControlledTerritory,
} from "./zoneControl.js"

export {
  scoreEnemyThreat,
  findMostThreateningEnemy,
  findWeakestEnemy,
  shouldFightOrFlee,
} from "./threatAssessment.js"

export {
  validateBombSafety,
  findBestSafeBombPosition,
  canSafelyBombCurrentPosition,
} from "./bombValidator.js"

export {
  findMultiTargetPath,
  findOptimalItemPath,
  compareSingleVsMultiTarget,
} from "./multiTargetPath.js"

export {
  findAdvancedEscapePath,
  detectBombChains,
  findChainSafePosition,
} from "./advancedEscape.js"
