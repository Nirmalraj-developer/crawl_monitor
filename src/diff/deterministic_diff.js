/**
 * Deterministic JSON Diff Engine (src/diff/deterministic_diff.js)
 * -----------------------------------------------------------------
 * Pure JavaScript diff calculation between old and new company records.
 * Recursively diffs:
 * - primitives, nulls, arrays, objects, strings, numbers, booleans.
 * Ignores:
 * - JSON key ordering, formatting, collapsible whitespace.
 * Distinguishes:
 * - ADDED, REMOVED, MODIFIED
 * Identifies:
 * - null -> value (enrichment flag)
 * - value -> null (removal flag)
 * Produces:
 * - Minimal company identity + list of changed fields only.
 */

function unwrapCompanyRecord(record) {
  if (!record) return {};
  if (Array.isArray(record.data) && record.data.length > 0) {
    return record.data[0];
  }
  return record;
}

function normalizeValue(val) {
  if (val === undefined || val === null) return null;
  if (typeof val === 'string') {
    const trimmed = val.trim().replace(/\s+/g, ' ');
    return trimmed;
  }
  return val;
}

function areEqual(a, b) {
  const normA = normalizeValue(a);
  const normB = normalizeValue(b);

  if (normA === normB) return true;
  if (normA === null || normB === null) return false;

  const typeA = typeof normA;
  const typeB = typeof normB;
  if (typeA !== typeB) return false;

  if (Array.isArray(normA) && Array.isArray(normB)) {
    if (normA.length !== normB.length) return false;
    for (let i = 0; i < normA.length; i++) {
      if (!areEqual(normA[i], normB[i])) return false;
    }
    return true;
  }

  if (typeA === 'object') {
    const keysA = Object.keys(normA).sort();
    const keysB = Object.keys(normB).sort();
    if (keysA.length !== keysB.length) return false;
    for (let i = 0; i < keysA.length; i++) {
      if (keysA[i] !== keysB[i]) return false;
      if (!areEqual(normA[keysA[i]], normB[keysB[i]])) return false;
    }
    return true;
  }

  return false;
}

function computeDeterministicDiff(oldObj, newObj, options = {}) {
  const oldTarget = unwrapCompanyRecord(oldObj);
  const newTarget = unwrapCompanyRecord(newObj);

  const changes = [];
  const ignoredKeys = new Set(options.ignoreKeys || [
    'processingId', 'loadTimeMs', 'hostIp', 'webServer', 'pingerInfo'
  ]);

  function walk(oldVal, newVal, currentPath) {
    const normOld = normalizeValue(oldVal);
    const normNew = normalizeValue(newVal);

    if (areEqual(normOld, normNew)) {
      return;
    }

    const oldIsNull = normOld === null || normOld === undefined;
    const newIsNull = normNew === null || normNew === undefined;

    if (oldIsNull && !newIsNull) {
      changes.push({
        path: currentPath,
        changeType: 'ADDED',
        oldValue: null,
        newValue: normNew,
        isNullToValue: true,
        isValueToNull: false
      });
      return;
    }

    if (!oldIsNull && newIsNull) {
      changes.push({
        path: currentPath,
        changeType: 'REMOVED',
        oldValue: normOld,
        newValue: null,
        isNullToValue: false,
        isValueToNull: true
      });
      return;
    }

    const typeOld = typeof normOld;
    const typeNew = typeof normNew;
    const isOldArr = Array.isArray(normOld);
    const isNewArr = Array.isArray(normNew);

    if (isOldArr && isNewArr) {
      changes.push({
        path: currentPath,
        changeType: 'MODIFIED',
        oldValue: normOld,
        newValue: normNew,
        isNullToValue: false,
        isValueToNull: false
      });
      return;
    }

    if (typeOld === 'object' && typeNew === 'object' && !isOldArr && !isNewArr) {
      const allKeys = Array.from(new Set([
        ...Object.keys(normOld || {}),
        ...Object.keys(normNew || {})
      ])).sort();

      for (const key of allKeys) {
        if (ignoredKeys.has(key)) continue;
        const subPath = currentPath ? `${currentPath}.${key}` : key;
        walk(normOld ? normOld[key] : undefined, normNew ? normNew[key] : undefined, subPath);
      }
      return;
    }

    changes.push({
      path: currentPath,
      changeType: 'MODIFIED',
      oldValue: normOld,
      newValue: normNew,
      isNullToValue: false,
      isValueToNull: false
    });
  }

  const rootKeys = Array.from(new Set([
    ...Object.keys(oldTarget || {}),
    ...Object.keys(newTarget || {})
  ])).sort();

  for (const key of rootKeys) {
    if (ignoredKeys.has(key)) continue;
    walk(oldTarget[key], newTarget[key], key);
  }

  const companyIdentity = {
    company_name: newTarget.companyName || newTarget.name || newTarget.nameFromTitle ||
                  oldTarget.companyName || oldTarget.name || oldTarget.nameFromTitle || 'Unknown Company',
    domain: newTarget.normalizedDomain || newTarget.url || oldTarget.normalizedDomain || oldTarget.url || 'unknown_domain'
  };

  return {
    company: companyIdentity,
    changes
  };
}

module.exports = {
  computeDeterministicDiff,
  unwrapCompanyRecord,
  areEqual,
  normalizeValue
};

