/**
 * Signal 1: Entity Changes (src/signals/entity_changes.js)
 * --------------------------------------------------------
 * Detects additions, removals, and modifications of critical named entities.
 * FIELD-AWARE:
 * - For IDENTITY fields: evaluates company / legal / brand names directly.
 * - For CONTACT fields: evaluates phone / email changes directly.
 * - For LOCATION fields: evaluates cities, countries, addresses directly.
 * - For TEXT fields: extracts named entities (companies, locations, phones, emails, dates).
 */

const { parsePhoneNumberFromString, findPhoneNumbersInText } = require('libphonenumber-js');

// Known country list for location entity detection
const KNOWN_COUNTRIES = new Set([
  'united kingdom', 'uk', 'united states', 'usa', 'us', 'canada', 'germany', 'france',
  'italy', 'spain', 'australia', 'india', 'ireland', 'netherlands', 'switzerland', 'belgium'
]);

// Known major cities
const KNOWN_CITIES = new Set([
  'london', 'manchester', 'birmingham', 'leeds', 'glasgow', 'liverpool', 'edinburgh',
  'new york', 'los angeles', 'chicago', 'san francisco', 'boston', 'seattle',
  'berlin', 'paris', 'amsterdam', 'dublin', 'madrid', 'mumbai', 'toronto', 'sydney'
]);

function extractPhones(text) {
  if (!text || typeof text !== 'string') return [];
  const found = findPhoneNumbersInText(text);
  const out = [];
  for (const item of found) {
    if (item.number) {
      out.push(item.number.number);
    }
  }
  return Array.from(new Set(out));
}

function extractEmails(text) {
  if (!text || typeof text !== 'string') return [];
  const regex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const matches = text.match(regex) || [];
  return Array.from(new Set(matches.map(m => m.toLowerCase())));
}

function extractRegNumbers(text) {
  if (!text || typeof text !== 'string') return [];
  // UK / standard corporate registration pattern (6-8 digits, or 2 letters + 6 digits)
  const regex = /\b(?:[0-9]{8}|[A-Z]{2}[0-9]{6})\b/g;
  const matches = text.match(regex) || [];
  return Array.from(new Set(matches));
}

function extractLocations(text) {
  if (!text || typeof text !== 'string') return [];
  const lower = text.toLowerCase();
  const found = [];
  for (const c of KNOWN_COUNTRIES) {
    const rx = new RegExp(`\\b${c}\\b`, 'i');
    if (rx.test(lower)) found.push(c);
  }
  for (const city of KNOWN_CITIES) {
    const rx = new RegExp(`\\b${city}\\b`, 'i');
    if (rx.test(lower)) found.push(city);
  }
  return Array.from(new Set(found));
}

/**
 * Field-Aware Entity Change Analyzer
 */
function analyzeEntityChanges(oldVal, newVal, context = {}) {
  const fieldType = context.fieldType || 'TEXT';
  const oldStr = oldVal !== null && oldVal !== undefined ? String(oldVal).trim() : '';
  const newStr = newVal !== null && newVal !== undefined ? String(newVal).trim() : '';

  // 1. IDENTITY field: compare company identity entity directly
  if (fieldType === 'IDENTITY') {
    const changed = oldStr.toLowerCase() !== newStr.toLowerCase();
    return {
      signal: 'entity_changes',
      fieldType: 'IDENTITY',
      entityType: 'COMPANY',
      oldEntity: oldStr || null,
      newEntity: newStr || null,
      hasChanges: changed,
      hasCriticalChange: changed && (Boolean(oldStr) !== Boolean(newStr) || (oldStr && newStr && oldStr !== newStr)),
      description: changed ? `Identity shifted from "${oldStr}" to "${newStr}"` : 'Identity unchanged'
    };
  }

  // 2. LOCATION field: compare country / address / city directly
  if (fieldType === 'LOCATION') {
    const changed = oldStr.toLowerCase() !== newStr.toLowerCase();
    return {
      signal: 'entity_changes',
      fieldType: 'LOCATION',
      entityType: 'LOCATION',
      oldEntity: oldStr || null,
      newEntity: newStr || null,
      hasChanges: changed,
      hasCriticalChange: changed,
      description: changed ? `Location shifted from "${oldStr}" to "${newStr}"` : 'Location unchanged'
    };
  }

  // 3. CONTACT field: phone or email
  if (fieldType === 'CONTACT') {
    const contactSub = context.contactSubtype || (oldStr.includes('@') ? 'EMAIL' : 'PHONE');
    const changed = oldStr !== newStr;
    return {
      signal: 'entity_changes',
      fieldType: 'CONTACT',
      entityType: contactSub,
      oldEntity: oldStr || null,
      newEntity: newStr || null,
      hasChanges: changed,
      hasCriticalChange: changed && !newStr, // Removal of contact channel is critical
      description: changed ? `${contactSub} channel changed from "${oldStr}" to "${newStr}"` : `${contactSub} unchanged`
    };
  }

  // 4. NATURAL LANGUAGE TEXT (Full entity extraction for body text)
  const oldPhones = extractPhones(oldStr);
  const newPhones = extractPhones(newStr);

  const oldEmails = extractEmails(oldStr);
  const newEmails = extractEmails(newStr);

  const oldRegs = extractRegNumbers(oldStr);
  const newRegs = extractRegNumbers(newStr);

  const oldLocs = extractLocations(oldStr);
  const newLocs = extractLocations(newStr);

  const phonesAdded = newPhones.filter(p => !oldPhones.includes(p));
  const phonesRemoved = oldPhones.filter(p => !newPhones.includes(p));

  const emailsAdded = newEmails.filter(e => !oldEmails.includes(e));
  const emailsRemoved = oldEmails.filter(e => !newEmails.includes(e));

  const regsAdded = newRegs.filter(r => !oldRegs.includes(r));
  const regsRemoved = oldRegs.filter(r => !newRegs.includes(r));

  const locsAdded = newLocs.filter(l => !oldLocs.includes(l));
  const locsRemoved = oldLocs.filter(l => !newLocs.includes(l));

  const totalAdded = phonesAdded.length + emailsAdded.length + regsAdded.length + locsAdded.length;
  const totalRemoved = phonesRemoved.length + emailsRemoved.length + regsRemoved.length + locsRemoved.length;
  const hasCriticalChange = phonesRemoved.length > 0 || emailsRemoved.length > 0 || regsRemoved.length > 0 || locsRemoved.length > 0;

  return {
    signal: 'entity_changes',
    fieldType: 'TEXT',
    hasChanges: totalAdded > 0 || totalRemoved > 0,
    hasCriticalChange,
    entities: {
      phones: { added: phonesAdded, removed: phonesRemoved },
      emails: { added: emailsAdded, removed: emailsRemoved },
      registrationNumbers: { added: regsAdded, removed: regsRemoved },
      locations: { added: locsAdded, removed: locsRemoved }
    },
    counts: {
      added: totalAdded,
      removed: totalRemoved
    }
  };
}

module.exports = {
  analyzeEntityChanges,
  extractPhones,
  extractEmails,
  extractRegNumbers,
  extractLocations
};
