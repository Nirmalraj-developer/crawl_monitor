/**
 * Configurable Multi-Signal Scoring Engine (src/scoring/scoring_engine.js)
 * ------------------------------------------------------------------------
 * FIELD-AWARE and IMPORTANCE-FIRST Scoring Engine:
 * - A business-critical factual change (CRITICAL/HIGH importance) ALWAYS overrides
 *   generic text similarity scores.
 * - Missing-value events (VALUE_REMOVED on CRITICAL fields) are flagged for human REVIEW.
 * - For TEXT fields, combines the 6 signals.
 * - Categorizes preliminary action: AUTO_ACCEPT | ESCALATE_TO_AI | IGNORE.
 */

const { IMPORTANCE_LEVELS, FIELD_TYPES } = require('../config/field_analysis_config');

function scoreFieldSignals(fieldItem) {
  const fieldType = fieldItem.fieldType || FIELD_TYPES.UNKNOWN;
  const importance = fieldItem.importance || IMPORTANCE_LEVELS.LOW;
  const compType = fieldItem.comparisonType || 'VALUE_MODIFIED';
  const sig = fieldItem.signals || {};

  // 1. If field importance is IGNORE -> 0 score, IGNORE
  if (importance === IMPORTANCE_LEVELS.IGNORE) {
    return {
      path: fieldItem.path,
      fieldType,
      importance,
      score: 0,
      classification: 'NOISE',
      action: 'IGNORE',
      needsAiEscalation: false,
      escalationReasons: [],
      reason: 'Field classified as operational noise or telemetry.'
    };
  }

  // 2. Factual Identifiers / Contact / Location / Factual Numbers
  if (fieldType === FIELD_TYPES.IDENTITY || fieldType === FIELD_TYPES.LOCATION || fieldType === FIELD_TYPES.CONTACT || (fieldType === FIELD_TYPES.NUMERIC && compType !== 'VALUE_MODIFIED')) {
    let score = 20;
    let action = 'AUTO_ACCEPT';
    let classification = 'CONTENT_UPDATE';
    let needsAiEscalation = false;
    const reasons = [];

    if (importance === IMPORTANCE_LEVELS.CRITICAL) {
      score = 90;
      action = 'REVIEW';
      classification = compType === 'VALUE_ADDED' ? 'ENRICHMENT' : 'CORRECTION';
      reasons.push(`Critical ${fieldType} change (${compType})`);
    } else if (importance === IMPORTANCE_LEVELS.HIGH) {
      score = 75;
      action = 'REVIEW';
      classification = compType === 'VALUE_ADDED' ? 'ENRICHMENT' : 'FACTUAL_CHANGE';
      reasons.push(`High-importance ${fieldType} change (${compType})`);
    }

    const desc = sig.entity_changes?.description || `${fieldType} changed from "${fieldItem.rawValues?.old}" to "${fieldItem.rawValues?.new}"`;

    return {
      path: fieldItem.path,
      fieldType,
      importance,
      score,
      classification,
      action,
      needsAiEscalation, // Factual changes have deterministic rule-based significance; no need to waste AI
      escalationReasons: reasons,
      reason: desc
    };
  }

  // 3. Missing Value on other fields (VALUE_REMOVED or VALUE_ADDED)
  if (compType === 'VALUE_REMOVED') {
    const isHigh = importance === IMPORTANCE_LEVELS.CRITICAL || importance === IMPORTANCE_LEVELS.HIGH;
    return {
      path: fieldItem.path,
      fieldType,
      importance,
      score: isHigh ? 70 : 25,
      classification: isHigh ? 'CORRECTION' : 'STRUCTURAL_CHANGE',
      action: isHigh ? 'REVIEW' : 'AUTO_ACCEPT',
      needsAiEscalation: isHigh,
      escalationReasons: isHigh ? ['Previously present value is no longer available'] : [],
      reason: `Field value was removed in the latest crawl.`
    };
  }

  if (compType === 'VALUE_ADDED') {
    return {
      path: fieldItem.path,
      fieldType,
      importance,
      score: 15,
      classification: 'ENRICHMENT',
      action: 'AUTO_ACCEPT',
      needsAiEscalation: false,
      escalationReasons: [],
      reason: `Newly discovered data attribute enriched from crawl.`
    };
  }

  // 4. NATURAL LANGUAGE TEXT (Both old and new text exist)
  // Calculate using all 6 signals:
  const embedSim = sig.embedding_semantic_similarity?.similarity ?? 1.0;
  const tfidfSim = sig.tfidf_cosine_similarity?.similarity ?? 1.0;
  const jaccardSim = sig.jaccard_similarity?.similarity ?? 1.0;
  const hasNumChange = sig.number_changes?.hasNumericDiscrepancy || false;
  const hasPolarityFlip = sig.negation_changes?.hasPolarityFlip || false;
  const hasEntityChange = sig.entity_changes?.hasCriticalChange || false;

  // Composite divergence score
  let textScore = Math.round(
    ((1.0 - embedSim) * 35) +
    ((1.0 - tfidfSim) * 25) +
    ((1.0 - jaccardSim) * 20) +
    (hasNumChange ? 25 : 0) +
    (hasPolarityFlip ? 40 : 0)
  );
  textScore = Math.min(100, Math.max(0, textScore));

  const reasons = [];
  if (hasPolarityFlip) {
    reasons.push('Polarity reversal detected (negation change)');
  }
  if (hasEntityChange) {
    reasons.push('Critical entity changed within text');
  }
  if (hasNumChange) {
    reasons.push(`Business numeric changes detected: added [${sig.number_changes.numbers.added.join(', ')}], removed [${sig.number_changes.numbers.removed.join(', ')}]`);
  }
  if (Math.abs(embedSim - tfidfSim) > 0.45) {
    reasons.push('Significant divergence between semantic embedding and keyword similarity');
  }

  // AI Escalation is triggered ONLY for genuinely ambiguous or high-divergence text changes
  const needsAiEscalation = hasPolarityFlip || hasEntityChange || (hasNumChange && textScore > 35) || textScore >= 50;

  return {
    path: fieldItem.path,
    fieldType,
    importance,
    score: textScore,
    classification: textScore < 30 ? 'CONTENT_UPDATE' : (hasPolarityFlip ? 'BUSINESS_CHANGE' : 'CONTENT_UPDATE'),
    action: needsAiEscalation ? 'ESCALATE_TO_AI' : (textScore < 30 ? 'AUTO_ACCEPT' : 'REVIEW'),
    needsAiEscalation,
    escalationReasons: reasons,
    signalsSummary: {
      embeddingSimilarity: embedSim,
      tfidfSimilarity: tfidfSim,
      jaccardSimilarity: jaccardSim,
      numberChanged: hasNumChange,
      negationChanged: hasPolarityFlip,
      entityChanged: hasEntityChange
    },
    reason: reasons.length > 0 ? reasons.join('; ') : 'Routine text rewording detected.'
  };
}

/**
 * Combines field scores into an overall company evaluation
 */
function evaluateCompanyScores(scoredFieldItems) {
  let criticalChangesCount = 0;
  let highChangesCount = 0;
  let itemsNeedingAi = [];

  for (const item of scoredFieldItems) {
    if (item.importance === IMPORTANCE_LEVELS.CRITICAL && item.action === 'REVIEW') criticalChangesCount++;
    if (item.importance === IMPORTANCE_LEVELS.HIGH && item.action === 'REVIEW') highChangesCount++;
    if (item.needsAiEscalation) {
      itemsNeedingAi.push(item);
    }
  }

  const hasFactualReviews = criticalChangesCount > 0 || highChangesCount > 0;
  const overallStatus = hasFactualReviews ? 'REVIEW' : (itemsNeedingAi.length > 0 ? 'ESCALATE_TO_AI' : 'AUTO_ACCEPT');

  return {
    overallStatus,
    criticalChangesCount,
    highChangesCount,
    itemsNeedingAiCount: itemsNeedingAi.length,
    itemsNeedingAi,
    fieldScores: scoredFieldItems
  };
}

module.exports = {
  scoreFieldSignals,
  evaluateCompanyScores
};
