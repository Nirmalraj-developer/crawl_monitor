/**
 * Six-Signal Analysis Layer (src/signals/index.js)
 * ------------------------------------------------
 * FIELD-AWARE Signal Dispatcher:
 * Runs ONLY the permitted signals based on the field type!
 *
 * For example:
 * - IDENTITY / LOCATION / CONTACT fields: runs entity / factual comparison ONLY.
 *   DO NOT run embeddings, TF-IDF, Jaccard, numbers, or negations.
 * - NUMERIC / FACT fields: runs number/entity check ONLY.
 * - TEXT fields: runs all 6 signals.
 *
 * Missing values (old present, new null or vice-versa):
 * - Emits VALUE_REMOVED or VALUE_ADDED instead of artificial 0 similarity.
 */

const { getFieldConfig } = require('../config/field_analysis_config');
const { normalizeFieldValue, areValuesEquivalent, isNullOrEmpty } = require('../normalization/normalizer');
const { analyzeEntityChanges } = require('./entity_changes');
const { computeEmbeddingSimilarity } = require('./embedding_similarity');
const { computeTfidfCosineSimilarity } = require('./tfidf_similarity');
const { computeJaccardSimilarity } = require('./jaccard_similarity');
const { analyzeNumberChanges } = require('./number_changes');
const { analyzeNegationChanges } = require('./negation_changes');

async function extractFieldSignals(oldVal, newVal, fieldPath, options = {}) {
  const fieldConfig = getFieldConfig(fieldPath);
  const fieldType = fieldConfig.fieldType;
  const allowedSignals = new Set(fieldConfig.allowedSignals || []);

  const normOld = normalizeFieldValue(oldVal, fieldConfig);
  const normNew = normalizeFieldValue(newVal, fieldConfig);

  // Check if values are equivalent after normalization
  const isEquivalent = areValuesEquivalent(oldVal, newVal, fieldConfig);
  if (isEquivalent) {
    return {
      fieldPath,
      fieldType,
      importance: fieldConfig.importance,
      isEquivalent: true,
      comparisonType: 'NO_MEANINGFUL_CHANGE',
      rawValues: { old: oldVal, new: newVal },
      normalizedValues: { old: normOld, new: normNew },
      signals: null
    };
  }

  // Handle Missing Value scenarios cleanly
  const oldMissing = isNullOrEmpty(normOld);
  const newMissing = isNullOrEmpty(normNew);

  if (oldMissing && !newMissing) {
    // VALUE_ADDED
    const signals = {};
    if (allowedSignals.has('entity_changes')) {
      signals.entity_changes = analyzeEntityChanges(null, normNew, { fieldType, ...fieldConfig });
    }
    return {
      fieldPath,
      fieldType,
      importance: fieldConfig.importance,
      isEquivalent: false,
      comparisonType: 'VALUE_ADDED',
      rawValues: { old: oldVal, new: newVal },
      normalizedValues: { old: null, new: normNew },
      similaritySignals: null,
      signals
    };
  }

  if (!oldMissing && newMissing) {
    // VALUE_REMOVED
    const signals = {};
    if (allowedSignals.has('entity_changes')) {
      signals.entity_changes = analyzeEntityChanges(normOld, null, { fieldType, ...fieldConfig });
    }
    return {
      fieldPath,
      fieldType,
      importance: fieldConfig.importance,
      isEquivalent: false,
      comparisonType: 'VALUE_REMOVED',
      rawValues: { old: oldVal, new: newVal },
      normalizedValues: { old: normOld, new: null },
      similaritySignals: null,
      signals
    };
  }

  // Both values exist and differ!
  // Run ONLY permitted signals for this field type:
  const signals = {};
  const tasks = [];

  const oldStr = typeof normOld === 'object' ? JSON.stringify(normOld) : String(normOld);
  const newStr = typeof normNew === 'object' ? JSON.stringify(normNew) : String(normNew);

  if (allowedSignals.has('entity_changes')) {
    tasks.push(
      Promise.resolve(analyzeEntityChanges(normOld, normNew, { fieldType, ...fieldConfig }))
        .then(res => { signals.entity_changes = res; })
    );
  }

  if (allowedSignals.has('embedding_semantic_similarity')) {
    tasks.push(
      computeEmbeddingSimilarity(oldStr, newStr, options)
        .then(res => { signals.embedding_semantic_similarity = res; })
    );
  }

  if (allowedSignals.has('tfidf_cosine_similarity')) {
    tasks.push(
      Promise.resolve(computeTfidfCosineSimilarity(oldStr, newStr))
        .then(res => { signals.tfidf_cosine_similarity = res; })
    );
  }

  if (allowedSignals.has('jaccard_similarity')) {
    tasks.push(
      Promise.resolve(computeJaccardSimilarity(oldStr, newStr))
        .then(res => { signals.jaccard_similarity = res; })
    );
  }

  if (allowedSignals.has('number_changes')) {
    tasks.push(
      Promise.resolve(analyzeNumberChanges(oldStr, newStr))
        .then(res => { signals.number_changes = res; })
    );
  }

  if (allowedSignals.has('negation_changes')) {
    tasks.push(
      Promise.resolve(analyzeNegationChanges(oldStr, newStr))
        .then(res => { signals.negation_changes = res; })
    );
  }

  await Promise.all(tasks);

  return {
    fieldPath,
    fieldType,
    importance: fieldConfig.importance,
    isEquivalent: false,
    comparisonType: 'VALUE_MODIFIED',
    rawValues: { old: oldVal, new: newVal },
    normalizedValues: { old: normOld, new: normNew },
    signals
  };
}

async function extractAllSignalsForChanges(changes, options = {}) {
  const signalResults = [];
  for (const ch of changes) {
    const fieldSignals = await extractFieldSignals(ch.oldValue, ch.newValue, ch.path, options);
    // If normalized to no meaningful change (e.g. null <-> empty string or URL tracking noise), skip or flag
    if (fieldSignals.isEquivalent) {
      continue; // Filtered noise!
    }
    signalResults.push({
      ...ch,
      ...fieldSignals
    });
  }
  return signalResults;
}

module.exports = {
  extractFieldSignals,
  extractAllSignalsForChanges
};
