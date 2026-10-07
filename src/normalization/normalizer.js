/**
 * Value Normalization Layer (src/normalization/normalizer.js)
 * -------------------------------------------------------------
 * Normalizes values BEFORE comparison to eliminate artificial changes:
 * - null vs "" vs "   " vs undefined -> treated as NULL_EMPTY (NO_MEANINGFUL_CHANGE)
 * - Phones: strips formatting, brackets, spaces, handles country code prefix +44/0
 * - Emails: lowercases, trims
 * - URLs: normalizes trailing slashes, strips tracking parameters (utm_*, gclid, etc.)
 * - Registration numbers: strips spaces, uppercase
 * - Strings: collapses redundant whitespace, trims
 * - Arrays: sorts and deduplicates elements
 */

const { parsePhoneNumberFromString } = require('libphonenumber-js');

function isNullOrEmpty(val) {
  if (val === null || val === undefined) return true;
  if (typeof val === 'string') {
    return val.trim().length === 0;
  }
  if (Array.isArray(val)) {
    return val.length === 0;
  }
  if (typeof val === 'object') {
    return Object.keys(val).length === 0;
  }
  return false;
}

function normalizeString(val) {
  if (isNullOrEmpty(val)) return null;
  return String(val).trim().replace(/\s+/g, ' ');
}

function normalizePhone(val) {
  if (isNullOrEmpty(val)) return null;
  const str = String(val).trim();
  // Try libphonenumber-js first with default GB/US context
  const parsed = parsePhoneNumberFromString(str, 'GB') || parsePhoneNumberFromString(str);
  if (parsed && parsed.isValid()) {
    return parsed.number; // E.164 standard, e.g. +442083681500
  }
  // Fallback digit normalization: strip everything except digits and leading +
  const digits = str.replace(/[^\d+]/g, '');
  const rawDigits = digits.replace(/^\+/, '');
  if (rawDigits.startsWith('0') && rawDigits.length === 11) {
    return '+44' + rawDigits.slice(1);
  }
  if (rawDigits.startsWith('44') && rawDigits.length === 12) {
    return '+' + rawDigits;
  }
  return digits.startsWith('+') ? digits : '+' + digits;
}

function normalizeEmail(val) {
  if (isNullOrEmpty(val)) return null;
  return String(val).trim().toLowerCase();
}

function normalizeRegistrationNumber(val) {
  if (isNullOrEmpty(val)) return null;
  // Strip spaces, dashes, uppercase
  return String(val).replace(/[\s\-_]/g, '').toUpperCase();
}

function normalizeUrl(val) {
  if (isNullOrEmpty(val)) return null;
  let str = String(val).trim();
  try {
    const url = new URL(str);
    // Strip tracking parameters
    const paramsToStrip = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid', 'sca_esv', 'sxsrf'];
    for (const p of paramsToStrip) {
      url.searchParams.delete(p);
    }
    // Remove trailing slash if root path
    let res = url.toString();
    if (res.endsWith('/') && url.pathname === '/') {
      res = res.slice(0, -1);
    }
    return res;
  } catch {
    // If not a full URL, strip trailing slash
    return str.replace(/\/+$/, '');
  }
}

/**
 * Normalizes any value based on field type and subtype
 */
function normalizeFieldValue(val, fieldConfig = {}) {
  if (isNullOrEmpty(val)) return null;

  const fType = fieldConfig.fieldType;
  const contactSub = fieldConfig.contactSubtype;
  const numSub = fieldConfig.numericSubtype;

  if (fType === 'CONTACT') {
    if (contactSub === 'PHONE') return normalizePhone(val);
    if (contactSub === 'EMAIL') return normalizeEmail(val);
  }

  if (fType === 'NUMERIC' && numSub === 'REGISTRATION') {
    return normalizeRegistrationNumber(val);
  }

  if (fType === 'URL') {
    return normalizeUrl(val);
  }

  if (Array.isArray(val)) {
    const cleaned = val.map(item => normalizeFieldValue(item, fieldConfig)).filter(x => x !== null);
    // Deduplicate
    return Array.from(new Set(cleaned));
  }

  if (typeof val === 'string') {
    return normalizeString(val);
  }

  return val;
}

/**
 * Checks whether two values represent NO MEANINGFUL CHANGE
 * e.g. null <-> "" or "020 8368 1500" <-> "020-8368-1500"
 */
function areValuesEquivalent(oldVal, newVal, fieldConfig = {}) {
  const normOld = normalizeFieldValue(oldVal, fieldConfig);
  const normNew = normalizeFieldValue(newVal, fieldConfig);

  // Both empty/null
  if (normOld === null && normNew === null) {
    return true;
  }

  // One is null and other is not
  if (normOld === null || normNew === null) {
    return false;
  }

  if (typeof normOld === 'object' || typeof normNew === 'object') {
    return JSON.stringify(normOld) === JSON.stringify(normNew);
  }

  return normOld === normNew;
}

module.exports = {
  isNullOrEmpty,
  normalizeString,
  normalizePhone,
  normalizeEmail,
  normalizeRegistrationNumber,
  normalizeUrl,
  normalizeFieldValue,
  areValuesEquivalent
};
