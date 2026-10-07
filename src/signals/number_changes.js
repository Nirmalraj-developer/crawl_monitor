/**
 * Signal 5: Number Changes (src/signals/number_changes.js)
 * --------------------------------------------------------
 * Detects numerical discrepancies across text fields.
 * CRITICAL FIX: Ignores numbers embedded inside URLs, query params, hashes, IDs,
 * session strings, or HTTP headers.
 * Focuses on business numbers:
 * - "28 years of experience"
 * - "500 employees"
 * - "£2 million" / "$50,000"
 * - "2023" / "25 locations"
 */

function stripUrlsFromText(text) {
  if (!text || typeof text !== 'string') return '';
  // Strip URLs (http://, https://, www., /path?id=12345)
  return text
    .replace(/https?:\/\/[^\s]+/gi, ' ')
    .replace(/www\.[^\s]+/gi, ' ')
    .replace(/\b[a-zA-Z0-9_\-\.]+\.[a-zA-Z]{2,}\/[^\s]*/gi, ' ')
    .replace(/[?&][a-zA-Z0-9_\-]+=[a-zA-Z0-9_\-%]+/gi, ' ')
    .replace(/\b[0-9a-f]{16,}\b/gi, ' '); // Strip long hex hashes/session tokens
}

function extractBusinessNumbers(text) {
  if (!text || typeof text !== 'string') return [];
  // First strip URLs and technical parameters
  const clean = stripUrlsFromText(text);

  // Match business numbers: currency, percentages, integers, decimals with units
  // E.g., "28 years", "500", "£2m", "10.5%"
  const regex = /(?:[\$£€¥])?\s*\b\d+(?:,\d+)*(?:\.\d+)?(?:\s*(?:years?|employees?|locations?|stores?|products?|clients?|customers?|%|k|m|b|million|billion))?\b/gi;
  const matches = clean.match(regex) || [];

  const results = [];
  for (const m of matches) {
    const trimmed = m.trim().toLowerCase();
    // Exclude single 1 or 0 if isolated (often boolean/formatting artifacts) unless with unit
    if ((trimmed === '0' || trimmed === '1') && !/[a-z$%£€¥]/.test(trimmed)) {
      continue;
    }
    // Exclude pure timestamp numbers like 1703063255116 (epoch)
    if (/^\d{10,}$/.test(trimmed)) {
      continue;
    }
    results.push(trimmed);
  }

  return Array.from(new Set(results));
}

function analyzeNumberChanges(oldText, newText) {
  const textA = oldText !== null && oldText !== undefined ? String(oldText) : '';
  const textB = newText !== null && newText !== undefined ? String(newText) : '';

  const oldNums = extractBusinessNumbers(textA);
  const newNums = extractBusinessNumbers(textB);

  const oldSet = new Set(oldNums);
  const newSet = new Set(newNums);

  const added = newNums.filter(n => !oldSet.has(n));
  const removed = oldNums.filter(n => !newSet.has(n));
  const retained = oldNums.filter(n => newSet.has(n));

  const total = new Set([...oldNums, ...newNums]).size;
  const hasNumericDiscrepancy = added.length > 0 || removed.length > 0;

  return {
    signal: 'number_changes',
    hasNumericDiscrepancy,
    numbers: {
      added: Array.from(new Set(added)),
      removed: Array.from(new Set(removed)),
      retained: Array.from(new Set(retained))
    },
    counts: {
      totalDistinct: total,
      addedCount: added.length,
      removedCount: removed.length,
      retainedCount: retained.length
    },
    numericShiftRatio: total === 0 ? 0 : parseFloat(((added.length + removed.length) / total).toFixed(4))
  };
}

module.exports = {
  analyzeNumberChanges,
  extractBusinessNumbers,
  stripUrlsFromText
};
