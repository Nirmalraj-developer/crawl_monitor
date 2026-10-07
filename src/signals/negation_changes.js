/**
 * Signal 6: Negation Changes (src/signals/negation_changes.js)
 * ------------------------------------------------------------
 * Detects polarity reversals in statements:
 * - "accepting orders" vs "not accepting orders"
 * - "open" vs "no longer open"
 * - "in business" vs "ceased operations / never / discontinued"
 *
 * Produces:
 * - hasPolarityFlip (boolean)
 * - addedNegations, removedNegations
 * - contextPhrases around negations
 */

const NEGATION_TERMS = [
  'not', 'no', 'never', 'neither', 'nor', 'none', 'cannot', 'cant', "can't",
  'wont', "won't", 'dont', "don't", 'ceased', 'closed', 'discontinued', 'stopped',
  'halted', 'suspended', 'prohibited', 'unavailable', 'out of service'
];

function extractNegationContexts(text) {
  if (!text || typeof text !== 'string') return [];
  const normalized = text.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ');
  const words = normalized.split(/\s+/).filter(Boolean);

  const occurrences = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (NEGATION_TERMS.includes(word)) {
      const windowStart = Math.max(0, i - 2);
      const windowEnd = Math.min(words.length, i + 3);
      const snippet = words.slice(windowStart, windowEnd).join(' ');
      occurrences.push({
        term: word,
        context: snippet
      });
    }
  }
  return occurrences;
}

function analyzeNegationChanges(oldText, newText) {
  const textA = oldText !== null && oldText !== undefined ? String(oldText) : '';
  const textB = newText !== null && newText !== undefined ? String(newText) : '';

  const occA = extractNegationContexts(textA);
  const occB = extractNegationContexts(textB);

  const termsA = occA.map(o => o.term);
  const termsB = occB.map(o => o.term);

  const setA = new Set(termsA);
  const setB = new Set(termsB);

  const addedTerms = Array.from(new Set(termsB.filter(t => !setA.has(t))));
  const removedTerms = Array.from(new Set(termsA.filter(t => !setB.has(t))));

  // Polarity flip flag
  const hasPolarityFlip = addedTerms.length > 0 || removedTerms.length > 0;

  return {
    signal: 'negation_changes',
    hasPolarityFlip,
    addedNegations: addedTerms,
    removedNegations: removedTerms,
    contexts: {
      old: occA.slice(0, 5),
      new: occB.slice(0, 5)
    },
    countShift: occB.length - occA.length
  };
}

module.exports = {
  analyzeNegationChanges,
  extractNegationContexts,
  NEGATION_TERMS
};

