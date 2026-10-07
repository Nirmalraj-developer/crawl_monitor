/**
 * Signal 4: Jaccard Similarity (src/signals/jaccard_similarity.js)
 * ---------------------------------------------------------------
 * Evaluates set-based intersection over union for words and character tokens.
 * Unaffected by word sequence / syntax re-ordering.
 *
 * Produces:
 * - jaccard similarity (0.0 to 1.0)
 * - intersection count
 * - union count
 * - overlap percentage
 */

const { removeStopwords, eng } = require('stopword');

function extractTokenSet(text) {
  if (!text || typeof text !== 'string') return new Set();
  const rawWords = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1);

  // Filter out stop words so Jaccard measures genuine content vocabulary overlap
  const contentWords = removeStopwords(rawWords, eng);
  return new Set(contentWords);
}

function computeJaccardSimilarity(oldText, newText) {
  const textA = oldText !== null && oldText !== undefined ? String(oldText).trim() : '';
  const textB = newText !== null && newText !== undefined ? String(newText).trim() : '';

  if (!textA && !textB) {
    return {
      signal: 'jaccard_similarity',
      similarity: 1.0,
      intersectionCount: 0,
      unionCount: 0,
      overlapPercentage: 100
    };
  }

  if (!textA || !textB) {
    const nonNull = textA ? extractTokenSet(textA) : extractTokenSet(textB);
    return {
      signal: 'jaccard_similarity',
      similarity: 0.0,
      intersectionCount: 0,
      unionCount: nonNull.size,
      overlapPercentage: 0
    };
  }

  const setA = extractTokenSet(textA);
  const setB = extractTokenSet(textB);

  if (setA.size === 0 && setB.size === 0) {
    return {
      signal: 'jaccard_similarity',
      similarity: 1.0,
      intersectionCount: 0,
      unionCount: 0,
      overlapPercentage: 100
    };
  }

  let intersectionCount = 0;
  for (const item of setA) {
    if (setB.has(item)) {
      intersectionCount++;
    }
  }

  const union = new Set([...setA, ...setB]);
  const unionCount = union.size;
  const similarity = unionCount === 0 ? 1.0 : intersectionCount / unionCount;

  return {
    signal: 'jaccard_similarity',
    similarity: parseFloat(similarity.toFixed(4)),
    intersectionCount,
    unionCount,
    overlapPercentage: parseFloat((similarity * 100).toFixed(1))
  };
}

module.exports = {
  computeJaccardSimilarity,
  extractTokenSet
};

