/**
 * Minimal Change Detection Tool (comparator.js)
 * ---------------------------------------------
 * Compares an OLD crawl JSON against a NEW crawl JSON for any company domain,
 * decides which field changes are VALID (real business changes, not crawl noise),
 * and produces a structured results entry.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parsePhoneNumberFromString, findPhoneNumbersInText } = require('libphonenumber-js');
const { getDomain, getSubdomain } = require('tldts');

// Optional crawler_service import (only used in CLI mode)
let crawlerService = null;
try {
  crawlerService = require('./crawler_service');
} catch {
  // Ignored if missing during unit test
}

// ============================================================================
// CONFIGURATION (Data, not logic)
// ============================================================================
const CONFIG = {
  // Volatile fields that are never compared
  VOLATILE_FIELDS: [
    'processingId', 'loadTimeMs', 'hostIp', 'webServer', 'pingerInfo'
  ],

  // Known fields for schema diffing
  KNOWN_FIELDS: [
    'processingId', 'loadTimeMs', 'hostIp', 'webServer', 'pingerInfo', 'ipCountry',
    'url', 'normalizedDomain', 'redirection', 'responseCode', 'domainStatus', 'comments',
    'homeContent', 'title', 'description', 'language',
    'companyName', 'name', 'nameFromTitle', 'nameFromCopyright', 'clearbitName',
    'phone', 'phoneFormatted', 'fax', 'faxFormatted',
    'email', 'genericEmail', 'nonGenericEmail',
    'imageUrl', 'socialLinks', 'domainMatchedSocialLinks', 'otherLinks',
    'contactLinks', 'privacyLinks', 'aboutLinks', 'termsLinks',
    'productLinks', 'ecommerceLinks', 'serviceLinks',
    'homeLinks', 'contactLinksAll', 'privacyLinksAll', 'aboutLinksAll', 'termsLinksAll',
    'contactPage', 'privacyPage', 'aboutPage', 'termsPage', 'productPage',
    'registration_number', 'address', 'postal_code'
  ],

  // ATS Recruitment platforms
  ATS_HOSTS: [
    'zohorecruit', 'lever', 'greenhouse', 'workable',
    'bamboohr', 'smartrecruiters', 'ashby', 'personio', 'teamtailor'
  ],

  // Subdomains classified as infrastructure / non-business
  INFRA_SUBDOMAINS: [
    'cdn', 'static', 'assets', 'mail', 'img', 'media', 'images', 'static1', 'cdn1', 'autodiscover'
  ],

  // Content route prefixes to separate from commercial catalog routes
  CONTENT_ROUTE_PREFIXES: [
    '/blog', '/news', '/events', '/press', '/careers', '/resources',
    '/guides', '/articles', '/case-studies', '/posts', '/insights', '/faq'
  ],

  // Challenge page phrases
  CHALLENGE_PHRASES: [
    'just a moment', 'attention required', 'cf-chl', 'challenge-form',
    'checking your browser', 'ddos-guard', 'cloudflare'
  ],

  // Parked or for-sale phrases
  PARKED_PHRASES: [
    'domain for sale', 'this domain is parked', 'buy this domain',
    'domain is available for purchase', 'parked free', 'hugedomains',
    'sedo.com', 'dan.com'
  ],

  // Legal suffixes and corporate modifiers for brand stems
  LEGAL_SUFFIXES: [
    'private limited', 'pvt ltd', 'pvt. ltd.', 'pvt', 'limited', 'ltd', 'ltd.',
    'incorporated', 'inc', 'inc.', 'corporation', 'corp', 'corp.',
    'limited liability company', 'llc', 'l.l.c.', 'llp', 'l.l.p.',
    'gmbh', 'plc', 's.a.', 'sa', 'b.v.', 'bv', 'co.', 'co', 'company',
    'srl', 's.r.l.'
  ],

  CORPORATE_MODIFIERS: [
    'group', 'holdings', 'holding', 'ventures', 'technologies', 'technology',
    'solutions', 'services', 'systems', 'consulting', 'international', 'global',
    'enterprises', 'digital'
  ],

  // Country registry for postcodes and registration patterns
  COUNTRY_REGISTRY: {
    GB: {
      postcodeRegex: /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i,
      registrationRegex: /(?:(?:Company|Registration|Reg(?:istered)?)\s*(?:No\.?|Number|#)?[:\s]*|Registered in England and Wales[,\s]+Company No\.?\s*)([0-9]{8}|[A-Z]{2}[0-9]{6})\b/i,
      entityNameNearRegRegex: /([A-Z0-9\s&.,'-]+(?:LTD|LIMITED|PLC|LLP))\s*(?:·|•|\||,|\.)?\s*(?:Company\s*No|Reg)/i,
    },
    IN: {
      postcodeRegex: /\b([1-9][0-9]{5})\b/,
      registrationRegex: /\b([UL][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6})\b/,
      entityNameNearRegRegex: /([A-Z0-9\s&.,'-]+(?:PVT\s*LTD|PRIVATE\s*LIMITED|LIMITED|LTD))\b/i,
    },
    US: {
      postcodeRegex: /\b(\d{5}(?:-\d{4})?)\b/,
      registrationRegex: /(?:EIN|Tax ID|FEIN)[:\s]*([0-9]{2}-[0-9]{7})\b/i,
      entityNameNearRegRegex: /([A-Z0-9\s&.,'-]+(?:INC|LLC|CORP|CORPORATION))\b/i,
    },
    DE: {
      postcodeRegex: /\b(\d{5})\b/,
      registrationRegex: /\b(HRB\s*\d{3,7}[A-Z]?|HRA\s*\d{3,7}[A-Z]?)\b/i,
      entityNameNearRegRegex: /([A-Z0-9\s&.,'-]+(?:GMBH|AG|KG|UG))\b/i,
    }
  },

  COUNTRY_MAP: {
    'germany': 'DE', 'united kingdom': 'GB', 'uk': 'GB', 'great britain': 'GB',
    'england': 'GB', 'united states': 'US', 'usa': 'US', 'india': 'IN',
    'france': 'FR', 'canada': 'CA', 'australia': 'AU', 'singapore': 'SG',
    'ireland': 'IE', 'netherlands': 'NL', 'spain': 'ES', 'italy': 'IT'
  },

  TLD_MAP: {
    'uk': 'GB', 'co.uk': 'GB', 'de': 'DE', 'in': 'IN', 'fr': 'FR',
    'ca': 'CA', 'au': 'AU', 'sg': 'SG', 'ie': 'IE', 'nl': 'NL',
    'es': 'ES', 'it': 'IT', 'us': 'US'
  },

  STOP_WORDS: new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'our', 'all', 'more',
    'your', 'you', 'are', 'was', 'were', 'been', 'will', 'have', 'has', 'had',
    'about', 'into', 'across', 'their', 'one', 'two', 'three', 'out', 'what',
    'over', 'when', 'which', 'who', 'how', 'its', 'not', 'can', 'than', 'them'
  ]),

  COMMERCIAL_KEYWORDS: [
    'pricing', 'product', 'service', 'solution', 'data', 'b2b', 'b2c',
    'api', 'platform', 'features', 'plans', 'shop', 'store', 'cart',
    'checkout', 'buy', 'demo', 'order'
  ]
};

// ============================================================================
// HELPERS
// ============================================================================

/**
 * 12-char SHA-256 hash of domain + field + normalized new value
 */
function hashChange(domain, field, value) {
  const payload = `${domain || ''}:${field || ''}:${String(value || '')}`;
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 12);
}

/**
 * Unwraps supported envelope shapes into the bare record.
 * Handles:
 *   - { status, message, totalCount, data: [record] }
 *   - { crawl_data: { status, data: [record] } }
 *   - [record]
 *   - bare record
 */
function unwrapEnvelope(input) {
  if (!input || typeof input !== 'object') {
    return { record: null, envelopeStatus: null, dataEmpty: true, hadEnvelope: false };
  }
  let envelopeStatus = input.status !== undefined ? input.status : null;
  let curr = input;

  if (curr.crawl_data && typeof curr.crawl_data === 'object') {
    if (curr.crawl_data.status !== undefined) envelopeStatus = curr.crawl_data.status;
    curr = curr.crawl_data;
  }

  if (Array.isArray(curr.data)) {
    return {
      record: curr.data.length > 0 ? curr.data[0] : null,
      envelopeStatus,
      dataEmpty: curr.data.length === 0,
      hadEnvelope: true
    };
  }

  if (Array.isArray(curr)) {
    return {
      record: curr.length > 0 ? curr[0] : null,
      envelopeStatus,
      dataEmpty: curr.length === 0,
      hadEnvelope: true
    };
  }

  return {
    record: curr,
    envelopeStatus,
    dataEmpty: false,
    hadEnvelope: input.status !== undefined || input.crawl_data !== undefined
  };
}

const URL_REGEX = /(?:https?:\/\/|tel:)[^\s"'<>\(\)\[\]{}|,]+/gi;

/**
 * Extracts and deduplicates every URL from arrays, bracket-strings, pipe-delimited strings,
 * comma/space separated strings, or nested objects.
 * @param {*} val
 * @returns {string[]} array of unique clean URLs
 */
function extractUrls(val) {
  if (!val) return [];
  const urls = new Set();

  function scan(v) {
    if (!v) return;
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (!trimmed) return;
      const matches = trimmed.match(URL_REGEX);
      if (matches) {
        for (let m of matches) {
          m = m.replace(/[.,;:!?\)>\]\}\'\"\-]+$/, '').trim();
          if (m) urls.add(m);
        }
      }
    } else if (Array.isArray(v)) {
      for (const item of v) {
        scan(item);
      }
    } else if (typeof v === 'object' && v !== null) {
      for (const subVal of Object.values(v)) {
        scan(subVal);
      }
    }
  }

  scan(val);
  return Array.from(urls);
}

// Backward-compatible alias
const parseLinkField = extractUrls;

/**
 * Normalizes a URL for canonical matching (lowercase host + clean pathname).
 */
function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return '';
  let str = url.trim();
  try {
    const parsed = new URL(str.startsWith('http') ? str : `https://${str}`);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    let pathname = parsed.pathname.toLowerCase().replace(/\/+$/, '');
    return `${host}${pathname}`;
  } catch {
    return str.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  }
}

/**
 * Strips dynamic noise (dates, copyright notices, counters, cookie disclaimers)
 */
function stripDynamicNoise(text) {
  if (!text || typeof text !== 'string') return '';
  let str = text;
  str = str.replace(/©\s*\d{4}(?:\s*-\s*\d{4})?/gi, ' ');
  str = str.replace(/all rights reserved/gi, ' ');
  str = str.replace(/\b(?:cookie policy|privacy policy|terms & conditions|cookie preferences|accept all cookies)\b/gi, ' ');
  str = str.replace(/\b\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}\b/gi, ' ');
  str = str.replace(/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+\d{4}\b/gi, ' ');
  str = str.replace(/\b\d+(?:[.,]\d+)?[kKmMbB]?\+\b/g, ' ');
  str = str.replace(/\b(?:latest from our blog|trending articles|related posts|recent news)\b[^.!?\n]*/gi, ' ');
  return str.replace(/\s+/g, ' ').trim();
}

/**
 * Clean tokens for Jaccard calculation (>2 chars)
 */
function cleanTokens(str) {
  if (!str) return [];
  const cleaned = stripDynamicNoise(str).toLowerCase();
  return cleaned
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);
}

/**
 * Token Jaccard similarity between two strings (0.0 to 1.0)
 */
function tokenJaccard(str1, str2) {
  const set1 = new Set(cleanTokens(str1));
  const set2 = new Set(cleanTokens(str2));
  if (set1.size === 0 && set2.size === 0) return 1.0;
  if (set1.size === 0 || set2.size === 0) return 0.0;
  let inter = 0;
  for (const t of set1) {
    if (set2.has(t)) inter++;
  }
  return inter / (set1.size + set2.size - inter);
}

/**
 * Selects the best title segment based on token overlap with domain and known brand names
 */
function selectBestTitleSegment(title, context = {}) {
  if (!title || typeof title !== 'string') return '';
  const segments = title.split(/[|\-–—]/).map(s => s.trim()).filter(Boolean);
  if (segments.length <= 1) return segments[0] || '';

  // Extract domain tokens
  const domain = context.domain || '';
  const domainLabel = domain.split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, ' ');
  const domainTokens = new Set(cleanTokens(domainLabel));

  // Extract known brand tokens
  const knownTokens = new Set();
  const knownList = context.knownNames || [];
  for (const n of knownList) {
    for (const t of cleanTokens(n)) knownTokens.add(t);
  }

  let bestSegment = segments[0];
  let bestScore = 0;

  for (const seg of segments) {
    const segTokens = cleanTokens(seg);
    let score = 0;
    for (const t of segTokens) {
      if (knownTokens.has(t)) score += 2;
      if (domainTokens.has(t) || domainLabel.includes(t)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestSegment = seg;
    }
  }

  return bestScore > 0 ? bestSegment : segments[0];
}

/**
 * Normalizes brand name stem according to specification
 */
function normalizeBrandStem(name, context = {}) {
  if (!name || typeof name !== 'string') return '';
  let clean = name.trim();
  clean = selectBestTitleSegment(clean, context);
  clean = clean.toLowerCase();
  clean = clean.replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  const original = clean;

  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of CONFIG.LEGAL_SUFFIXES) {
      const re = new RegExp('\\b' + suffix.replace(/\./g, '\\.') + '\\b$', 'i');
      if (re.test(clean)) {
        clean = clean.replace(re, '').trim();
        changed = true;
      }
    }
    for (const mod of CONFIG.CORPORATE_MODIFIERS) {
      const re = new RegExp('\\b' + mod + '\\b$', 'i');
      if (re.test(clean)) {
        clean = clean.replace(re, '').trim();
        changed = true;
      }
    }
  }
  return clean || original;
}

/**
 * Infers 2-letter ISO country code from record hints.
 * Priority: company address country / postcode pattern -> site TLD country -> language.
 * NEVER use ipCountry (it is the hosting location).
 */
function inferCountry(rec) {
  if (!rec) return 'GB';

  // 1. Company address country or address text
  if (rec.country) {
    const c = CONFIG.COUNTRY_MAP[String(rec.country).toLowerCase().trim()];
    if (c) return c;
  }
  if (rec.address && typeof rec.address === 'string') {
    const low = rec.address.toLowerCase();
    for (const [name, code] of Object.entries(CONFIG.COUNTRY_MAP)) {
      if (low.includes(name)) return code;
    }
  }

  // Check postcode pattern in postal_code or contactPage/address
  const textToCheck = `${rec.postal_code || ''} ${rec.address || ''} ${rec.contactPage ? rec.contactPage.slice(0, 1000) : ''}`;
  for (const [countryCode, regConfig] of Object.entries(CONFIG.COUNTRY_REGISTRY)) {
    if (regConfig.postcodeRegex && regConfig.postcodeRegex.test(textToCheck)) {
      return countryCode;
    }
  }

  // 2. Site TLD country
  const dom = rec.normalizedDomain || rec.url || '';
  const parts = dom.split('/')[0].split('.');
  if (parts.length > 1) {
    const tld = parts.slice(-1)[0].toLowerCase();
    if (CONFIG.TLD_MAP[tld]) return CONFIG.TLD_MAP[tld];
    const twoTld = parts.slice(-2).join('.').toLowerCase();
    if (CONFIG.TLD_MAP[twoTld]) return CONFIG.TLD_MAP[twoTld];
  }

  // 3. Language
  if (rec.language) {
    const lang = String(rec.language).toLowerCase().trim();
    if (lang === 'de') return 'DE';
    if (lang === 'fr') return 'FR';
    if (lang === 'es') return 'ES';
    if (lang === 'it') return 'IT';
    if (lang === 'nl') return 'NL';
  }

  return 'GB';
}

/**
 * Normalizes a single phone string to E.164 using libphonenumber-js
 */
function normalizePhoneSingle(phoneStr, countryHint) {
  if (!phoneStr || typeof phoneStr !== 'string') return null;
  const trimmed = phoneStr.trim();
  try {
    const parsed = trimmed.startsWith('+')
      ? parsePhoneNumberFromString(trimmed)
      : parsePhoneNumberFromString(trimmed, countryHint);
    if (parsed && parsed.isValid()) {
      return parsed.format('E.164');
    }
  } catch {}
  return null;
}

const REJECT_PREV_LABEL = /(?:company\s*no\.?|company\s*number|reg(?:istration)?(?:\s*no\.?|\s*number)?|vat(?:\s*no\.?|\s*number)?|ico(?:\s*no\.?)?|crn|no\.?|#|id)\s*[:.\-]?\s*$/i;
const ALLOW_PREV_LABEL = /(?:phone|tel|call|mobile|telephone|t:|p:|contact)\s*[:.\-]?\s*$/i;

/**
 * Validates whether a phone number found in page text has valid context.
 */
function isPhoneValidInContext(text, item, rec) {
  if (!item || !item.number || !item.number.isValid()) return false;

  const rawSnippet = text.slice(item.startsAt, item.endsAt).trim();
  const prev35 = text.slice(Math.max(0, item.startsAt - 35), item.startsAt);
  const prev20 = text.slice(Math.max(0, item.startsAt - 20), item.startsAt);

  // 1. Check negative context (Reject if preceded by company no, reg, vat, etc.)
  if (REJECT_PREV_LABEL.test(prev35)) {
    return false;
  }

  // 2. Check context requirement:
  // Must be preceded within 20 chars by a phone label OR start with '+' or '(0'
  const hasLabel = ALLOW_PREV_LABEL.test(prev20);
  const startsWithPlusOrZero = rawSnippet.startsWith('+') || rawSnippet.startsWith('(0');
  if (!hasLabel && !startsWithPlusOrZero) {
    return false;
  }

  // 3. Reject if matches extracted registration number
  const regNum = rec.registration_number || (typeof extractRegistration === 'function' ? extractRegistration(rec)?.number : null);
  if (regNum) {
    const cleanReg = String(regNum).replace(/\D/g, '');
    const numDigits = String(item.number.nationalNumber || '').replace(/\D/g, '');
    const rawDigits = rawSnippet.replace(/\D/g, '');
    if (cleanReg && (cleanReg === numDigits || cleanReg === rawDigits)) {
      return false;
    }
  }

  return true;
}

/**
 * Collects and normalizes all phones from a record
 */
function extractAllPhones(rec) {
  const phones = new Set();
  const country = inferCountry(rec);

  // 1. Primary phone fields
  for (const field of ['phone', 'phoneFormatted']) {
    const val = rec[field];
    if (val) {
      const parsed = normalizePhoneSingle(String(val), country);
      if (parsed) {
        const regNum = rec.registration_number || (typeof extractRegistration === 'function' ? extractRegistration(rec)?.number : null);
        const cleanReg = regNum ? String(regNum).replace(/\D/g, '') : null;
        if (!cleanReg || !parsed.endsWith(cleanReg)) {
          phones.add(parsed);
        }
      }
    }
  }

  // 2. Extracted from contactPage / aboutPage
  for (const field of ['contactPage', 'aboutPage']) {
    const text = rec[field];
    if (text && typeof text === 'string') {
      try {
        const found = findPhoneNumbersInText(text, country);
        for (const item of found) {
          if (isPhoneValidInContext(text, item, rec)) {
            phones.add(item.number.format('E.164'));
          }
        }
      } catch {}
    }
  }

  // 3. Extracted from tel: links in raw link pool
  const rawLinks = getRawLinkPool(rec);
  for (const link of rawLinks) {
    if (typeof link === 'string' && link.toLowerCase().startsWith('tel:')) {
      const raw = link.replace(/^tel:/i, '').split('?')[0].trim();
      const parsed = normalizePhoneSingle(raw, country);
      if (parsed) phones.add(parsed);
    }
  }

  return phones;
}

/**
 * Counts how many independent sources contain the given phone number:
 * 1) phone / phoneFormatted field
 * 2) contactPage
 * 3) aboutPage
 * 4) raw link pool tel: links
 */
function countPhoneSources(rec, targetPhone) {
  let count = 0;
  const country = inferCountry(rec);

  // 1. Phone fields
  let foundInField = false;
  for (const f of ['phone', 'phoneFormatted']) {
    const val = rec[f];
    if (val) {
      const parsed = normalizePhoneSingle(String(val), country);
      if (parsed === targetPhone) {
        foundInField = true;
        break;
      }
    }
  }
  if (foundInField) count++;

  // 2. contactPage
  if (rec.contactPage && typeof rec.contactPage === 'string') {
    try {
      const found = findPhoneNumbersInText(rec.contactPage, country);
      if (found.some(item => isPhoneValidInContext(rec.contactPage, item, rec) && item.number.format('E.164') === targetPhone)) {
        count++;
      }
    } catch {}
  }

  // 3. aboutPage
  if (rec.aboutPage && typeof rec.aboutPage === 'string') {
    try {
      const found = findPhoneNumbersInText(rec.aboutPage, country);
      if (found.some(item => isPhoneValidInContext(rec.aboutPage, item, rec) && item.number.format('E.164') === targetPhone)) {
        count++;
      }
    } catch {}
  }

  // 4. tel: links in raw link pool
  const rawLinks = getRawLinkPool(rec);
  let foundInHomeLinks = false;
  for (const link of rawLinks) {
    if (typeof link === 'string' && link.toLowerCase().startsWith('tel:')) {
      const raw = link.replace(/^tel:/i, '').split('?')[0].trim();
      const parsed = normalizePhoneSingle(raw, country);
      if (parsed === targetPhone) {
        foundInHomeLinks = true;
        break;
      }
    }
  }
  if (foundInHomeLinks) count++;

  return count;
}

/**
 * Collects and normalizes all fax numbers from a record
 */
function extractAllFax(rec) {
  const faxNumbers = new Set();
  const country = inferCountry(rec);
  for (const field of ['fax', 'faxFormatted']) {
    const val = rec[field];
    if (val) {
      const parsed = normalizePhoneSingle(String(val), country);
      if (parsed) faxNumbers.add(parsed);
    }
  }
  return faxNumbers;
}

/**
 * Validates and extracts clean emails
 */
function extractAllEmails(rec) {
  const primary = new Set();
  const secondary = new Set();
  const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;

  function addCleanEmail(rawEmail, targetSet) {
    if (!rawEmail) return;
    const clean = String(rawEmail).trim().toLowerCase();
    if (clean.includes('@') && !clean.endsWith('@domain.com') && !clean.endsWith('@example.com')) {
      targetSet.add(clean);
    }
  }

  // Primary fields
  for (const field of ['email', 'genericEmail', 'nonGenericEmail']) {
    const val = rec[field];
    if (val && typeof val === 'string') {
      const parts = val.split(/[|,;\s]+/);
      for (const p of parts) addCleanEmail(p, primary);
    }
  }

  // contactPage emails
  if (rec.contactPage && typeof rec.contactPage === 'string') {
    const matches = rec.contactPage.match(emailRegex) || [];
    for (const m of matches) addCleanEmail(m, primary);
  }

  // Secondary (legal / about pages)
  for (const field of ['privacyPage', 'termsPage', 'aboutPage']) {
    if (rec[field] && typeof rec[field] === 'string') {
      const matches = rec[field].match(emailRegex) || [];
      for (const m of matches) addCleanEmail(m, secondary);
    }
  }

  return { primary, secondary };
}

/**
 * Gathers all raw URLs from every link-bearing field of a record.
 */
function getRawLinkPool(rec) {
  if (!rec) return [];
  return extractUrls([
    rec.homeLinks,
    rec.home_alllinks,
    rec.contactLinksAll,
    rec.privacyLinksAll,
    rec.aboutLinksAll,
    rec.termsLinksAll,
    rec.about_alllinks,
    rec.contact_alllinks,
    rec.privacy_alllinks,
    rec.terms_alllinks,
    rec.productLinks,
    rec.ecommerceLinks,
    rec.serviceLinks,
    rec.contactLinks,
    rec.privacyLinks,
    rec.aboutLinks,
    rec.termsLinks,
    rec.otherLinks
  ]);
}

/**
 * Normalizes social links and extracts handles
 */
function extractSocialFootprint(rec) {
  const platforms = {};

  function addLink(url) {
    if (!url || typeof url !== 'string') return;
    const clean = url.trim().toLowerCase();
    try {
      const parsed = new URL(clean.startsWith('http') ? clean : `https://${clean}`);
      const host = parsed.hostname.replace(/^www\./, '');
      let platform = null;
      if (host.includes('twitter.com') || host.includes('x.com')) platform = 'twitter';
      else if (host.includes('linkedin.com')) platform = 'linkedin';
      else if (host.includes('facebook.com')) platform = 'facebook';
      else if (host.includes('instagram.com')) platform = 'instagram';
      else if (host.includes('youtube.com')) platform = 'youtube';
      else if (host.includes('github.com')) platform = 'github';

      if (platform) {
        let parts = parsed.pathname.replace(/^\/+|\/+$/g, '').split('/');
        let handle = parts[0];
        if (platform === 'linkedin' && (parts[0] === 'company' || parts[0] === 'in') && parts[1]) {
          handle = parts[1];
        }
        if (handle && !platforms[platform]) {
          platforms[platform] = handle;
        }
      }
    } catch {}
  }

  // 1. socialLinks & domainMatchedSocialLinks
  for (const field of ['socialLinks', 'domainMatchedSocialLinks']) {
    if (rec[field] && typeof rec[field] === 'object') {
      for (const [k, v] of Object.entries(rec[field])) {
        if (!['privacy', 'terms'].includes(k.toLowerCase())) {
          addLink(v);
        }
      }
    }
  }

  // 2. All links in raw pool
  const pool = getRawLinkPool(rec);
  for (const link of pool) {
    addLink(link);
  }

  return platforms;
}

/**
 * Extracts postcode from text checking all supported countries in CONFIG.COUNTRY_REGISTRY
 */
function extractPostcodeFromText(text) {
  if (!text || typeof text !== 'string') return null;
  for (const [countryCode, regConfig] of Object.entries(CONFIG.COUNTRY_REGISTRY)) {
    const m = text.match(regConfig.postcodeRegex);
    if (m) {
      return m[1].toUpperCase().replace(/\s+/g, '');
    }
  }
  return null;
}

/**
 * Extracts postcodes per source
 */
function extractPostcodes(rec) {
  const sources = {};
  if (!rec) return sources;

  // Source 0: top-level postal_code / address fields (e.g. DB baseline)
  if (rec.postal_code && String(rec.postal_code).trim()) {
    sources.postal_code = String(rec.postal_code).trim().toUpperCase().replace(/\s+/g, '');
  }
  if (rec.address && typeof rec.address === 'string') {
    const pc = extractPostcodeFromText(rec.address);
    if (pc) sources.address = pc;
  }

  // Source 1: contactPage
  if (rec.contactPage && typeof rec.contactPage === 'string') {
    const pc = extractPostcodeFromText(rec.contactPage);
    if (pc) sources.contactPage = pc;
  }

  // Source 2: Google Maps link in homeLinks
  const links = parseLinkField(rec.homeLinks);
  for (const l of links) {
    if (l.includes('google.com/maps') || l.includes('maps.google.com') || l.includes('query=')) {
      try {
        const u = new URL(l.startsWith('http') ? l : `https://${l}`);
        const query = u.searchParams.get('query') || u.searchParams.get('q') || '';
        if (query) {
          const decoded = decodeURIComponent(query.replace(/\+/g, ' '));
          const pc = extractPostcodeFromText(decoded);
          if (pc) {
            sources.mapsLink = pc;
            break;
          }
        }
      } catch {}
    }
  }

  // Source 3: aboutPage
  if (rec.aboutPage && typeof rec.aboutPage === 'string') {
    const pc = extractPostcodeFromText(rec.aboutPage);
    if (pc) sources.aboutPage = pc;
  }

  // Source 4: Legal pages
  for (const field of ['privacyPage', 'termsPage']) {
    if (rec[field] && typeof rec[field] === 'string') {
      const pc = extractPostcodeFromText(rec[field]);
      if (pc) {
        sources.legalPage = pc;
        break;
      }
    }
  }

  return sources;
}

/**
 * Extracts company registration numbers from record or page text
 */
function extractRegistration(rec) {
  if (!rec) return null;
  if (rec.registration_number && String(rec.registration_number).trim()) {
    return {
      number: String(rec.registration_number).trim(),
      source: 'registration_number',
      country: inferCountry(rec)
    };
  }
  for (const field of ['privacyPage', 'contactPage', 'termsPage', 'aboutPage']) {
    const text = rec[field];
    if (text && typeof text === 'string') {
      for (const [countryCode, regConfig] of Object.entries(CONFIG.COUNTRY_REGISTRY)) {
        const m = text.match(regConfig.registrationRegex);
        if (m) {
          return {
            number: m[1].trim(),
            source: field,
            country: countryCode
          };
        }
      }
    }
  }
  return null;
}

/**
 * Top-5 TF keywords from text
 */
function extractTop5Keywords(text) {
  if (!text) return [];
  const words = cleanTokens(text);
  const counts = {};
  for (const w of words) {
    if (CONFIG.STOP_WORDS.has(w)) continue;
    counts[w] = (counts[w] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(entry => entry[0]);
}

/**
 * Collapses route variants into one family root:
 * numeric suffixes (/shop-1, /shop-5), /page/N, pagination params, trailing numbers.
 */
function getRouteFamily(route) {
  if (!route || typeof route !== 'string') return '';
  let str = route.toLowerCase().trim();
  str = str.split('?')[0];
  str = str.replace(/\/+$/, '');
  str = str.replace(/\/(?:page|p)[-_/]\d+$/i, '');
  str = str.replace(/\/\d+$/i, '');
  str = str.replace(/[-_]\d+$/i, '');
  return str;
}

/**
 * Gathers unique normalized links across the link pool for coverage calculation
 */
function getUniqueLinksInPool(rec) {
  const pool = new Set();
  const rawList = [
    ...extractUrls(rec.homeLinks),
    ...extractUrls(rec.home_alllinks)
  ];
  if (rawList.length === 0) {
    rawList.push(...getRawLinkPool(rec));
  }
  for (const l of rawList) {
    const norm = normalizeUrl(l);
    if (norm) pool.add(norm);
  }
  return pool;
}

/**
 * Categorizes link lists into catalog routes and content routes
 */
function extractCatalogAndContentRoutes(rec, targetDomain) {
  const catalogRoutes = new Set();
  const contentRoutes = new Set();
  const baseDomain = targetDomain ? (getDomain(targetDomain) || targetDomain) : (rec?.normalizedDomain ? (getDomain(rec.normalizedDomain) || rec.normalizedDomain) : null);

  const rawList = getRawLinkPool(rec);

  const nonCommercialPrefixes = [
    '/privacy', '/terms', '/cookie', '/contact', '/about', '/gdpr',
    '/do-not-sell', '/login', '/auth', '/signup', '/signin', '/register'
  ];

  for (const raw of rawList) {
    try {
      const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
      const host = u.hostname.toLowerCase();
      if (baseDomain && getDomain(host) !== baseDomain) continue;

      const path = u.pathname.toLowerCase().replace(/\/+$/, '');
      const full = host.replace(/^www\./, '') + path;

      if (!path || path === '') {
        if (host.startsWith('product.') || host.startsWith('store.') || host.startsWith('shop.')) {
          catalogRoutes.add(full);
        }
        continue;
      }

      const isContent = CONFIG.CONTENT_ROUTE_PREFIXES.some(prefix => path.includes(prefix));
      if (isContent) {
        contentRoutes.add(full);
        continue;
      }

      if (nonCommercialPrefixes.some(p => path.includes(p))) {
        continue;
      }

      const isClassified = [
        ...extractUrls(rec.productLinks),
        ...extractUrls(rec.ecommerceLinks),
        ...extractUrls(rec.serviceLinks)
      ].some(l => l.toLowerCase().includes(path));

      const hasCommKeyword = CONFIG.COMMERCIAL_KEYWORDS.some(k => (host + path).includes(k));

      if (isClassified || hasCommKeyword) {
        catalogRoutes.add(full);
      }
    } catch {}
  }

  return { catalogRoutes, contentRoutes };
}

/**
 * Extracts subdomains for the target domain
 */
function extractSubdomains(rec, targetDomain) {
  const subdomains = new Set();
  const baseDomain = targetDomain ? getDomain(targetDomain) : null;
  if (!baseDomain) return subdomains;

  const linkPool = getRawLinkPool(rec);

  for (const link of linkPool) {
    if (!link || typeof link !== 'string') continue;
    try {
      const u = new URL(link.startsWith('http') ? link : `https://${link}`);
      const host = u.hostname.toLowerCase();
      const domainOfLink = getDomain(host);

      if (domainOfLink === baseDomain) {
        const sub = getSubdomain(host);
        if (sub && sub !== 'www') {
          // Check if infra
          if (!CONFIG.INFRA_SUBDOMAINS.includes(sub.toLowerCase())) {
            subdomains.add(sub.toLowerCase());
          }
        }
      }
    } catch {}
  }

  return subdomains;
}

/**
 * ATS classifier for career links
 */
function classifyCareerLink(url) {
  if (!url || typeof url !== 'string') return null;
  const clean = url.toLowerCase();
  for (const ats of CONFIG.ATS_HOSTS) {
    if (clean.includes(ats)) return ats;
  }
  return 'internal';
}

/**
 * Extracts candidate career URL from otherLinks or raw link pool.
 */
function extractCareerLink(rec) {
  if (rec.otherLinks?.career) return rec.otherLinks.career;
  const pool = getRawLinkPool(rec);
  for (const l of pool) {
    const ats = classifyCareerLink(l);
    if (ats && ats !== 'internal') {
      return l;
    }
  }
  for (const l of pool) {
    const low = l.toLowerCase();
    if (low.includes('/career') || low.includes('/jobs') || low.includes('/join-us') || low.includes('/work-with-us')) {
      return l;
    }
  }
  return null;
}

/**
 * Evaluates baseline quality and detects issues.
 * @param {object} oldJson 
 * @param {object} oldRec 
 * @param {object} newJson 
 * @param {object} newRec 
 * @returns {{ level: 'high'|'medium'|'low', issues: string[] }}
 */
function evaluateBaselineQuality(oldJson, oldRec, newJson, newRec) {
  const issues = [];
  oldRec = oldRec || {};
  newRec = newRec || {};

  // 1. baseline_pages_missing: page bodies null while new record has them
  const pageFields = ['contactPage', 'privacyPage', 'aboutPage', 'termsPage'];
  const oldMissing = pageFields.filter(f => !oldRec[f] || String(oldRec[f]).trim() === '');
  const newPresent = pageFields.filter(f => newRec[f] && String(newRec[f]).trim() !== '');
  if (oldMissing.length > 0 && newPresent.length > 0) {
    issues.push('baseline_pages_missing');
  }

  // 2. baseline_catalog_unclassified: productLinks/serviceLinks/ecommerceLinks empty
  // while old link pool contains commercial-looking routes
  const oldClassified = [
    ...extractUrls(oldRec.productLinks),
    ...extractUrls(oldRec.ecommerceLinks),
    ...extractUrls(oldRec.serviceLinks)
  ];
  if (oldClassified.length === 0) {
    const oldLinkPool = extractUrls([
      oldRec.homeLinks,
      oldRec.home_alllinks,
      oldRec.contactLinksAll,
      oldRec.privacyLinksAll,
      oldRec.aboutLinksAll,
      oldRec.termsLinksAll,
      oldRec.otherLinks
    ]);
    const hasCommercial = oldLinkPool.some(u => {
      try {
        const parsed = new URL(u.startsWith('http') ? u : `https://${u}`);
        const pathAndHost = (parsed.hostname + parsed.pathname).toLowerCase();
        return CONFIG.COMMERCIAL_KEYWORDS.some(k => pathAndHost.includes(k));
      } catch {
        return CONFIG.COMMERCIAL_KEYWORDS.some(k => u.toLowerCase().includes(k));
      }
    });
    if (hasCommercial) {
      issues.push('baseline_catalog_unclassified');
    }
  }

  // 3. baseline_stale_meta: old title/description inconsistent with old homeContent
  const oldHome = String(oldRec.homeContent || '').trim();
  if (oldHome) {
    let stale = false;
    if (oldRec.title) {
      const heading = oldHome.slice(0, 150).toLowerCase();
      const oldTitleClean = String(oldRec.title).toLowerCase().trim();
      const oldTitleStem = oldTitleClean.split(/[|\-–—]/)[0].trim();
      if (oldTitleStem.length > 3 && !heading.includes(oldTitleStem.slice(0, 20))) {
        stale = true;
      }
    }
    if (!stale && oldRec.description && newRec.description) {
      const oldTokens = cleanTokens(oldRec.description);
      const newTokens = cleanTokens(newRec.description);
      const homeTokens = new Set(cleanTokens(oldHome));
      const oldMatches = oldTokens.filter(t => homeTokens.has(t)).length / (oldTokens.length || 1);
      const newMatches = newTokens.filter(t => homeTokens.has(t)).length / (newTokens.length || 1);
      if (newMatches > oldMatches * 1.5 && newMatches > 0.6) {
        stale = true;
      }
    }
    if (stale) {
      issues.push('baseline_stale_meta');
    }
  }

  // 4. baseline_different_pipeline: envelope message contains "DB baseline" or ipCountry null
  const envelopeMsg = String(oldJson?.message || '');
  if (envelopeMsg.toLowerCase().includes('db baseline') || oldRec.ipCountry === null || oldRec.ipCountry === undefined) {
    issues.push('baseline_different_pipeline');
  }

  const level = issues.length >= 2 ? 'low' : (issues.length === 1 ? 'medium' : 'high');
  return { level, issues };
}

// ============================================================================
// CORE COMPARATOR (Pure, synchronous)
// ============================================================================

/**
 * Compares an OLD crawl JSON against a NEW crawl JSON.
 * @param {object} oldJson 
 * @param {object} newJson 
/**
 * Extracts baseline crawl timestamp from record or envelope.
 */
function extractBaselineTimestamp(oldInput, oldRec) {
  const candidates = [
    oldRec?.crawled_at,
    oldRec?.crawledAt,
    oldRec?.created_at,
    oldRec?.updated_at,
    oldRec?.saved_at,
    oldRec?.crawl_date,
    oldRec?._file_mtime,
    oldInput?.saved_at,
    oldInput?.crawled_at,
    oldInput?.crawledAt,
    oldInput?.compared_at,
    oldInput?.created_at,
    oldInput?.updated_at,
    oldInput?._file_mtime
  ];
  for (const c of candidates) {
    if (c) {
      const dt = new Date(c);
      if (!isNaN(dt.getTime())) {
        return dt.toISOString();
      }
    }
  }
  return null;
}

/**
 * Main Pure Comparator Function
 * @param {object} oldJson
 * @param {object} newJson
 * @returns {object} result entry
 */
function compareCrawls(oldJson, newJson, options = {}) {
  const oldExtracted = unwrapEnvelope(oldJson);
  const newExtracted = unwrapEnvelope(newJson);

  const oldRec = oldExtracted.record || {};
  const newRec = newExtracted.record || {};
  const domain = newRec.normalizedDomain || oldRec.normalizedDomain || newRec.domain || oldRec.domain || 'unknown';

  const baselineCrawledAt = extractBaselineTimestamp(oldJson, oldRec);
  let baselineAgeDays = null;
  if (baselineCrawledAt) {
    const diffMs = Date.now() - new Date(baselineCrawledAt).getTime();
    baselineAgeDays = Math.max(0, Number((diffMs / 86400000).toFixed(1)));
  }

  const baselineQuality = evaluateBaselineQuality(oldJson, oldRec, newJson, newRec);
  const baselineGaps = [];

  // --------------------------------------------------------------------------
  // STEP 0: Is the new crawl trustworthy?
  // --------------------------------------------------------------------------

  // Envelope status !== 1
  if (newExtracted.hadEnvelope && newExtracted.envelopeStatus !== null && newExtracted.envelopeStatus !== 1) {
    return {
      domain,
      compared_at: new Date().toISOString(),
      baseline_crawled_at: baselineCrawledAt,
      baseline_age_days: baselineAgeDays,
      status: 'inconclusive',
      reason: `envelope_status_${newExtracted.envelopeStatus}`,
      has_meaningful_change: false,
      has_pending_confirmation: false,
      summary: `Crawl inconclusive due to API envelope status ${newExtracted.envelopeStatus}.`,
      changes: [],
      noise_detected: [],
      unchanged_fields: [],
      not_found_fields: []
    };
  }

  // Data array empty or missing record
  if (newExtracted.dataEmpty || !newExtracted.record) {
    return {
      domain,
      compared_at: new Date().toISOString(),
      baseline_crawled_at: baselineCrawledAt,
      baseline_age_days: baselineAgeDays,
      status: 'inconclusive',
      reason: 'empty_crawl_data',
      has_meaningful_change: false,
      has_pending_confirmation: false,
      summary: 'Crawl inconclusive because no crawl records were returned.',
      changes: [],
      noise_detected: [],
      unchanged_fields: [],
      not_found_fields: []
    };
  }

  // normalizedDomain differs between old and new
  const oldNormDomain = oldRec.normalizedDomain ? String(oldRec.normalizedDomain).toLowerCase().trim() : null;
  const newNormDomain = newRec.normalizedDomain ? String(newRec.normalizedDomain).toLowerCase().trim() : null;
  if (oldNormDomain && newNormDomain && oldNormDomain !== newNormDomain) {
    return {
      domain,
      compared_at: new Date().toISOString(),
      baseline_crawled_at: baselineCrawledAt,
      baseline_age_days: baselineAgeDays,
      status: 'inconclusive',
      reason: 'domain_mismatch',
      has_meaningful_change: false,
      has_pending_confirmation: false,
      summary: `Domain mismatch between baseline (${oldNormDomain}) and new crawl (${newNormDomain}).`,
      changes: [],
      noise_detected: [],
      unchanged_fields: [],
      not_found_fields: []
    };
  }

  // responseCode 403, 429, 503
  const newRespCode = String(newRec.responseCode || '').trim();
  if (['403', '429', '503'].includes(newRespCode)) {
    return {
      domain,
      compared_at: new Date().toISOString(),
      baseline_crawled_at: baselineCrawledAt,
      baseline_age_days: baselineAgeDays,
      status: 'inconclusive',
      reason: `http_${newRespCode}`,
      has_meaningful_change: false,
      has_pending_confirmation: false,
      summary: `Crawl inconclusive due to HTTP ${newRespCode} response code.`,
      changes: [],
      noise_detected: [],
      unchanged_fields: [],
      not_found_fields: []
    };
  }

  // Challenge page in homeContent
  const newHomeContent = String(newRec.homeContent || '');
  for (const phrase of CONFIG.CHALLENGE_PHRASES) {
    if (newHomeContent.toLowerCase().includes(phrase)) {
      return {
        domain,
        compared_at: new Date().toISOString(),
        baseline_crawled_at: baselineCrawledAt,
        baseline_age_days: baselineAgeDays,
        status: 'inconclusive',
        reason: 'challenge_page_detected',
        has_meaningful_change: false,
        has_pending_confirmation: false,
        summary: `Challenge or security checkpoint page detected ("${phrase}").`,
        changes: [],
        noise_detected: [],
        unchanged_fields: [],
        not_found_fields: []
      };
    }
  }

  // homeContent under 30% or SPA shell
  const oldHomeLen = (oldRec.homeContent || '').trim().length;
  const newHomeLen = newHomeContent.trim().length;
  if (oldHomeLen > 100 && newHomeLen < 0.3 * oldHomeLen) {
    return {
      domain,
      compared_at: new Date().toISOString(),
      baseline_crawled_at: baselineCrawledAt,
      baseline_age_days: baselineAgeDays,
      status: 'inconclusive',
      reason: 'js_rendering_required',
      has_meaningful_change: false,
      has_pending_confirmation: false,
      summary: 'Page content was under 30% of baseline length; JS rendering required.',
      changes: [],
      noise_detected: [],
      unchanged_fields: [],
      not_found_fields: []
    };
  }

  const lowHome = newHomeContent.toLowerCase();
  if (
    lowHome.includes('enable javascript') ||
    lowHome.includes('javascript is required') ||
    lowHome.includes('you need to enable javascript') ||
    (newHomeLen < 150 && lowHome.includes('javascript'))
  ) {
    return {
      domain,
      compared_at: new Date().toISOString(),
      baseline_crawled_at: baselineCrawledAt,
      baseline_age_days: baselineAgeDays,
      status: 'inconclusive',
      reason: 'js_rendering_required',
      has_meaningful_change: false,
      has_pending_confirmation: false,
      summary: 'JavaScript rendering required (SPA shell detected).',
      changes: [],
      noise_detected: [],
      unchanged_fields: [],
      not_found_fields: []
    };
  }

  // Partial crawl: more than half of old non-null scalar fields are null in new
  let oldScalarCount = 0;
  let newNullCount = 0;
  for (const [k, v] of Object.entries(oldRec)) {
    if (CONFIG.VOLATILE_FIELDS.includes(k)) continue;
    if (v !== null && v !== undefined && typeof v !== 'object' && String(v).trim() !== '') {
      oldScalarCount++;
      const nv = newRec[k];
      if (nv === null || nv === undefined || String(nv).trim() === '') {
        newNullCount++;
      }
    }
  }
  if (oldScalarCount >= 6 && (newNullCount / oldScalarCount) > 0.5) {
    return {
      domain,
      compared_at: new Date().toISOString(),
      baseline_crawled_at: baselineCrawledAt,
      baseline_age_days: baselineAgeDays,
      status: 'inconclusive',
      reason: 'partial_crawl',
      has_meaningful_change: false,
      has_pending_confirmation: false,
      summary: 'Crawl incomplete: over 50% of baseline fields were empty in the new crawl.',
      changes: [],
      noise_detected: [],
      unchanged_fields: [],
      not_found_fields: []
    };
  }

  // Redirection: domain_redirect may ONLY fire when the FINAL host's registrable domain (via tldts)
  // differs from the target domain AND differs from the old snapshot's final host.
  // Apex to www, http to https, trailing-slash/path redirects and subdomain redirects within the same
  // registrable domain are NOT redirects: continue with the full field comparison.
  const targetRegistrableDomain = getDomain(domain) || domain;
  const newFinalHostDomain = newRec.url ? getDomain(newRec.url) : targetRegistrableDomain;
  const oldFinalHostDomain = oldRec.url ? getDomain(oldRec.url) : (oldNormDomain ? getDomain(oldNormDomain) : targetRegistrableDomain);

  const isExternalRedirect = Boolean(
    newFinalHostDomain &&
    newFinalHostDomain !== targetRegistrableDomain &&
    newFinalHostDomain !== oldFinalHostDomain
  );

  if (isExternalRedirect) {
    const alertChange = {
      field: 'redirection',
      change_type: 'domain_redirect',
      old_value: oldRec.url || oldNormDomain || domain,
      new_value: newRec.url || newNormDomain,
      description: `Domain redirected from ${oldRec.url || oldNormDomain || domain} to ${newRec.url || newNormDomain}.`,
      tier: 'alert',
      needs_confirmation: false,
      confidence: 1.0,
      evidence: `Final registrable domain ${newFinalHostDomain} differs from target ${targetRegistrableDomain} and baseline ${oldFinalHostDomain}`,
      change_id: hashChange(domain, 'redirection', newRec.url || newNormDomain)
    };
    return {
      domain,
      compared_at: new Date().toISOString(),
      baseline_crawled_at: baselineCrawledAt,
      baseline_age_days: baselineAgeDays,
      status: 'ok',
      has_meaningful_change: true,
      has_pending_confirmation: false,
      summary: `Domain redirected to ${newRec.url || newNormDomain}.`,
      changes: [alertChange],
      noise_detected: [],
      unchanged_fields: [],
      not_found_fields: []
    };
  }

  // --------------------------------------------------------------------------
  // UNIVERSAL FIELD DIFFING
  // --------------------------------------------------------------------------
  const changes = [];
  const noiseDetected = [];
  const unchangedFields = [];
  const notFoundFields = [];

  // Compute coverage for both crawls
  const oldPool = getUniqueLinksInPool(oldRec);
  const newPool = getUniqueLinksInPool(newRec);
  const oldLinksCount = oldPool.size;
  const newLinksCount = newPool.size;
  const coverageRatio = oldLinksCount === 0
    ? (newLinksCount === 0 ? 1.0 : 999.0)
    : Number((newLinksCount / oldLinksCount).toFixed(3));

  const coverage = {
    old_links: oldLinksCount,
    new_links: newLinksCount,
    ratio: coverageRatio
  };

  const isCoverageImbalanced = (coverageRatio < 0.5 || coverageRatio > 2.0);

  // Helper to add noise
  function addNoise(field, oldVal, newVal, reason) {
    noiseDetected.push({
      field,
      old_value: oldVal,
      new_value: newVal,
      reason
    });
  }

  // 1. STATUS & SITE AVAILABILITY
  const is404or410 = ['404', '410'].includes(newRespCode);
  const statusNotValid = newRec.domainStatus && String(newRec.domainStatus).toLowerCase() !== 'valid';
  let parkedPhraseFound = null;
  for (const phrase of CONFIG.PARKED_PHRASES) {
    if (newHomeContent.toLowerCase().includes(phrase)) {
      parkedPhraseFound = phrase;
      break;
    }
  }

  if (is404or410 || statusNotValid || parkedPhraseFound) {
    const reasonText = is404or410
      ? `HTTP ${newRespCode}`
      : (parkedPhraseFound ? `parked domain phrase ("${parkedPhraseFound}")` : `domain status "${newRec.domainStatus}"`);
    changes.push({
      field: 'website_status',
      change_type: 'offline_or_parked',
      old_value: 'active',
      new_value: reasonText,
      description: `Website availability issue detected (${reasonText}).`,
      tier: 'alert_if_confirmed',
      needs_confirmation: true,
      confidence: 0.9,
      evidence: `Crawl status check: ${reasonText}`,
      change_id: hashChange(domain, 'website_status', reasonText)
    });
  } else {
    unchangedFields.push('domainStatus');
  }

  // 2. BRAND NAMES
  const brandSources = ['companyName', 'name', 'clearbitName', 'nameFromTitle', 'nameFromCopyright'];
  const brandStemsOld = {};
  const brandStemsNew = {};
  const changedBrandSources = [];

  const brandContext = {
    domain,
    knownNames: [
      oldRec.companyName, oldRec.name, oldRec.clearbitName,
      newRec.companyName, newRec.name, newRec.clearbitName
    ].filter(Boolean)
  };

  for (const src of brandSources) {
    const oVal = oldRec[src];
    const nVal = newRec[src];

    if (oVal && !nVal) {
      notFoundFields.push(src);
    } else if (!oVal && nVal) {
      // Added
      changes.push({
        field: src,
        change_type: 'added',
        old_value: null,
        new_value: nVal,
        description: `Brand name source ${src} was added as "${nVal}".`,
        tier: 'log_only',
        needs_confirmation: false,
        confidence: 0.8,
        evidence: `Source ${src} newly discovered`,
        change_id: hashChange(domain, src, nVal)
      });
    } else if (oVal && nVal) {
      const oStem = normalizeBrandStem(oVal, brandContext);
      const nStem = normalizeBrandStem(nVal, brandContext);
      brandStemsOld[src] = oStem;
      brandStemsNew[src] = nStem;

      if (oStem === nStem) {
        if (String(oVal).trim() !== String(nVal).trim()) {
          addNoise(src, oVal, nVal, 'cosmetic: legal suffix / whitespace / minor wording');
        } else {
          unchangedFields.push(src);
        }
      } else {
        changedBrandSources.push({
          source: src,
          old_val: oVal,
          new_val: nVal,
          old_stem: oStem,
          new_stem: nStem
        });
      }
    }
  }

  if (changedBrandSources.length > 0) {
    const isMultiSource = changedBrandSources.length >= 2;
    const isTopPrimary = changedBrandSources.some(s => ['companyName', 'name'].includes(s.source));
    const isRebrandAlert = isMultiSource || isTopPrimary;

    const primaryChange = changedBrandSources[0];
    changes.push({
      field: 'company_name',
      change_type: isRebrandAlert ? 'rebrand' : 'brand_name_drift',
      old_value: primaryChange.old_val,
      new_value: primaryChange.new_val,
      description: isRebrandAlert
        ? `Company rebranded from "${primaryChange.old_val}" to "${primaryChange.new_val}".`
        : `Brand name variation detected in ${primaryChange.source} ("${primaryChange.old_val}" -> "${primaryChange.new_val}").`,
      tier: isRebrandAlert ? 'alert' : 'log_only',
      needs_confirmation: false,
      confidence: isRebrandAlert ? 0.95 : 0.7,
      evidence: `Stems changed across: ${changedBrandSources.map(s => s.source).join(', ')}`,
      change_id: hashChange(domain, 'company_name', primaryChange.new_val)
    });
  }

  // 3. HOME CONTENT & THEMATIC DRIFT
  let homeThemeChanged = false;
  if (oldRec.homeContent && newRec.homeContent) {
    const homeSim = tokenJaccard(oldRec.homeContent, newRec.homeContent);
    if (homeSim >= 0.85) {
      if (String(oldRec.homeContent).trim() !== String(newRec.homeContent).trim()) {
        addNoise('homeContent', '...', '...', 'cosmetic: whitespace / minor wording');
      } else {
        unchangedFields.push('homeContent');
      }
    } else {
      const top5Old = extractTop5Keywords(oldRec.homeContent);
      const top5New = extractTop5Keywords(newRec.homeContent);
      const overlap = top5Old.filter(w => top5New.includes(w)).length;
      if (overlap <= 1) {
        homeThemeChanged = true;
      }
    }
  }

  // 4. CATALOG & SERVICE ROUTES
  const oldCatalog = extractCatalogAndContentRoutes(oldRec, domain);
  const newCatalog = extractCatalogAndContentRoutes(newRec, domain);

  const oldFamilies = new Set(Array.from(oldCatalog.catalogRoutes).map(getRouteFamily));
  const newFamilies = new Set(Array.from(newCatalog.catalogRoutes).map(getRouteFamily));

  const addedCatalogFamilies = Array.from(newFamilies).filter(f => !oldFamilies.has(f));
  const removedCatalogFamilies = Array.from(oldFamilies).filter(f => !newFamilies.has(f));
  const addedContentRoutes = Array.from(newCatalog.contentRoutes).filter(r => !oldCatalog.contentRoutes.has(r));

  let catalogExpanded = false;
  if (addedCatalogFamilies.length > 0) {
    catalogExpanded = true;
    const catTier = isCoverageImbalanced ? 'log_only' : 'alert_if_confirmed';
    const catNeedsConfirm = !isCoverageImbalanced;
    changes.push({
      field: 'catalog',
      change_type: 'catalog_expanded',
      old_value: `${oldFamilies.size} commercial route families`,
      new_value: addedCatalogFamilies.slice(0, 3).join(', '),
      description: `New commercial product or service offerings added (${addedCatalogFamilies.length} new route families).`,
      tier: catTier,
      needs_confirmation: catNeedsConfirm,
      confidence: isCoverageImbalanced ? 0.6 : 0.9,
      evidence: isCoverageImbalanced
        ? `Added families: ${addedCatalogFamilies.slice(0, 5).join(', ')} (downgraded due to coverage_difference: ratio ${coverageRatio})`
        : `Added route families: ${addedCatalogFamilies.slice(0, 5).join(', ')}`,
      ...(isCoverageImbalanced ? { reason: 'coverage_difference' } : {}),
      change_id: hashChange(domain, 'catalog', addedCatalogFamilies.join(','))
    });
  }

  if (removedCatalogFamilies.length > 0) {
    changes.push({
      field: 'catalog',
      change_type: 'catalog_reduced',
      old_value: removedCatalogFamilies.slice(0, 3).join(', '),
      new_value: `${newFamilies.size} commercial route families`,
      description: `Commercial catalog routes removed (${removedCatalogFamilies.length} families).`,
      tier: 'log_only',
      needs_confirmation: false,
      confidence: 0.7,
      evidence: isCoverageImbalanced
        ? `Removed families: ${removedCatalogFamilies.slice(0, 5).join(', ')} (coverage_difference: ratio ${coverageRatio})`
        : `Removed families: ${removedCatalogFamilies.slice(0, 5).join(', ')}`,
      ...(isCoverageImbalanced ? { reason: 'coverage_difference' } : {}),
      change_id: hashChange(domain, 'catalog_removed', removedCatalogFamilies.join(','))
    });
  }

  if (addedContentRoutes.length > 0) {
    changes.push({
      field: 'content_links',
      change_type: 'content_expanded',
      old_value: null,
      new_value: addedContentRoutes.slice(0, 3).join(', '),
      description: `New informational or blog content routes detected (${addedContentRoutes.length} routes).`,
      tier: 'log_only',
      needs_confirmation: false,
      confidence: 0.8,
      evidence: `New content routes: ${addedContentRoutes.slice(0, 5).join(', ')}`,
      change_id: hashChange(domain, 'content_links', addedContentRoutes.join(','))
    });
  }

  if (homeThemeChanged) {
    const isCorroborated = catalogExpanded;
    changes.push({
      field: 'homeContent',
      change_type: 'thematic_pivot',
      old_value: 'Previous thematic focus',
      new_value: 'New thematic focus',
      description: isCorroborated
        ? 'Website messaging and core business themes have pivoted substantially.'
        : 'Substantial update to homepage copy and thematic messaging.',
      tier: isCorroborated ? 'alert_if_confirmed' : 'log_only',
      needs_confirmation: isCorroborated,
      confidence: isCorroborated ? 0.85 : 0.65,
      evidence: `Keyword overlap <= 1${isCorroborated ? ' and catalog routes expanded' : ''}`,
      change_id: hashChange(domain, 'homeContent', 'thematic_pivot')
    });
  }

  // 5. TITLE & DESCRIPTION
  if (oldRec.title && newRec.title) {
    const titleSim = tokenJaccard(oldRec.title, newRec.title);
    if (titleSim >= 0.60) {
      if (String(oldRec.title).trim() !== String(newRec.title).trim()) {
        addNoise('title', oldRec.title, newRec.title, 'cosmetic: legal suffix / whitespace / minor wording');
      } else {
        unchangedFields.push('title');
      }
    } else {
      const isStaleMeta = baselineQuality?.issues?.includes('baseline_stale_meta');
      changes.push({
        field: 'title',
        change_type: 'modified',
        old_value: oldRec.title,
        new_value: newRec.title,
        description: `Page title changed from "${oldRec.title}" to "${newRec.title}".`,
        tier: 'log_only',
        needs_confirmation: false,
        confidence: 0.7,
        ...(isStaleMeta ? { reason: 'baseline_stale_meta' } : {}),
        evidence: `Token Jaccard similarity: ${titleSim.toFixed(2)}${isStaleMeta ? ' (baseline_stale_meta)' : ''}`,
        change_id: hashChange(domain, 'title', newRec.title)
      });
    }
  } else if (oldRec.title && !newRec.title) {
    notFoundFields.push('title');
  }

  if (oldRec.description && newRec.description) {
    const descSim = tokenJaccard(oldRec.description, newRec.description);
    if (descSim >= 0.60) {
      if (String(oldRec.description).trim() !== String(newRec.description).trim()) {
        addNoise('description', oldRec.description, newRec.description, 'cosmetic: whitespace / minor wording');
      } else {
        unchangedFields.push('description');
      }
    } else {
      const isValidatedCatalog = catalogExpanded && !isCoverageImbalanced && baselineQuality.level !== 'low';
      const isCorroborated = homeThemeChanged || isValidatedCatalog;
      const isStaleMeta = baselineQuality?.issues?.includes('baseline_stale_meta');
      const descTier = isCorroborated && !isStaleMeta ? 'alert_if_confirmed' : 'log_only';
      changes.push({
        field: 'description',
        change_type: 'modified',
        old_value: oldRec.description,
        new_value: newRec.description,
        description: `Company description updated: "${newRec.description}".`,
        tier: descTier,
        needs_confirmation: descTier === 'alert_if_confirmed',
        confidence: descTier === 'alert_if_confirmed' ? 0.85 : 0.6,
        ...(isStaleMeta ? { reason: 'baseline_stale_meta' } : {}),
        evidence: `Jaccard ${descSim.toFixed(2)}${isCorroborated && !isStaleMeta ? ' with corroboration' : ''}${isStaleMeta ? ' (baseline_stale_meta)' : ''}`,
        change_id: hashChange(domain, 'description', newRec.description)
      });
    }
  } else if (oldRec.description && !newRec.description) {
    notFoundFields.push('description');
  }

  // Language
  if (oldRec.language && newRec.language) {
    if (String(oldRec.language).trim().toLowerCase() !== String(newRec.language).trim().toLowerCase()) {
      changes.push({
        field: 'language',
        change_type: 'modified',
        old_value: oldRec.language,
        new_value: newRec.language,
        description: `Site language changed from ${oldRec.language} to ${newRec.language}.`,
        tier: 'alert_if_confirmed',
        needs_confirmation: true,
        confidence: 0.9,
        evidence: `Language code modified from ${oldRec.language} to ${newRec.language}`,
        change_id: hashChange(domain, 'language', newRec.language)
      });
    } else {
      unchangedFields.push('language');
    }
  }

  // 6. PHONES
  const oldPhones = extractAllPhones(oldRec);
  const newPhones = extractAllPhones(newRec);

  if (oldPhones.size > 0 && newPhones.size === 0) {
    notFoundFields.push('phone');
  } else if (oldPhones.size === 0 && newPhones.size > 0) {
    const addedList = Array.from(newPhones).join(', ');
    const oldPagesMissing = (!oldRec.contactPage || !oldRec.contactPage.trim()) && (!oldRec.aboutPage || !oldRec.aboutPage.trim());
    if (oldPagesMissing) {
      baselineGaps.push({
        field: 'phone',
        change_type: 'baseline_gap',
        old_value: null,
        new_value: addedList,
        description: `Phone number discovered from newly crawled page (${addedList}).`,
        tier: 'log_only',
        needs_confirmation: false,
        confidence: 0.8,
        evidence: 'Baseline page bodies were missing in old crawl; phone extracted from new crawl',
        change_id: hashChange(domain, 'phone', addedList)
      });
    } else {
      changes.push({
        field: 'phone',
        change_type: 'added',
        old_value: null,
        new_value: addedList,
        description: `New phone number discovered: ${addedList}.`,
        tier: 'log_only',
        needs_confirmation: false,
        confidence: 0.9,
        evidence: 'New phone number found on site',
        change_id: hashChange(domain, 'phone', addedList)
      });
    }
  } else if (oldPhones.size > 0 && newPhones.size > 0) {
    const overlap = Array.from(oldPhones).filter(p => newPhones.has(p));
    if (overlap.length === oldPhones.size && oldPhones.size === newPhones.size) {
      unchangedFields.push('phone');
    } else if (overlap.length === 0) {
      // Complete replacement: check independent sources corroboration (Item 4)
      const oStr = Array.from(oldPhones).join(', ');
      const nStr = Array.from(newPhones).join(', ');
      const maxSources = Math.max(
        ...Array.from(newPhones).map(p => countPhoneSources(newRec, p)),
        0
      );
      const isCorroborated = maxSources >= 2;
      changes.push({
        field: 'phone',
        change_type: 'modified',
        old_value: oStr,
        new_value: nStr,
        description: `Phone number changed from ${oStr} to ${nStr}.`,
        tier: isCorroborated ? 'alert' : 'alert_if_confirmed',
        needs_confirmation: !isCorroborated,
        confidence: isCorroborated ? 0.95 : 0.75,
        evidence: `Zero overlap between baseline phone set and new phone set (${maxSources} independent source(s) found)`,
        change_id: hashChange(domain, 'phone', nStr)
      });
    } else {
      // Partial addition or removal
      const nStr = Array.from(newPhones).join(', ');
      changes.push({
        field: 'phone',
        change_type: 'partial_update',
        old_value: Array.from(oldPhones).join(', '),
        new_value: nStr,
        description: `Phone number list updated (${nStr}).`,
        tier: 'log_only',
        needs_confirmation: false,
        confidence: 0.8,
        evidence: 'Partial overlap in phone numbers',
        change_id: hashChange(domain, 'phone', nStr)
      });
    }
  }

  // Fax
  const oldFax = extractAllFax(oldRec);
  const newFax = extractAllFax(newRec);
  if (oldFax.size > 0 && newFax.size > 0) {
    const overlap = Array.from(oldFax).filter(f => newFax.has(f));
    if (overlap.length === 0) {
      changes.push({
        field: 'fax',
        change_type: 'modified',
        old_value: Array.from(oldFax).join(', '),
        new_value: Array.from(newFax).join(', '),
        description: `Fax number changed to ${Array.from(newFax).join(', ')}.`,
        tier: 'log_only',
        needs_confirmation: false,
        confidence: 0.9,
        evidence: 'Fax number changed',
        change_id: hashChange(domain, 'fax', Array.from(newFax).join(', '))
      });
    }
  }

  // 7. EMAILS
  const oldEmails = extractAllEmails(oldRec);
  const newEmails = extractAllEmails(newRec);

  if (oldEmails.primary.size > 0 && newEmails.primary.size === 0) {
    notFoundFields.push('email');
  } else if (oldEmails.primary.size === 0 && newEmails.primary.size > 0) {
    const nStr = Array.from(newEmails.primary).join(', ');
    changes.push({
      field: 'email',
      change_type: 'added',
      old_value: null,
      new_value: nStr,
      description: `New contact email address discovered: ${nStr}.`,
      tier: 'log_only',
      needs_confirmation: false,
      confidence: 0.85,
      evidence: 'New email discovered',
      change_id: hashChange(domain, 'email', nStr)
    });
  } else if (oldEmails.primary.size > 0 && newEmails.primary.size > 0) {
    const overlap = Array.from(oldEmails.primary).filter(e => newEmails.primary.has(e));
    if (overlap.length === oldEmails.primary.size && oldEmails.primary.size === newEmails.primary.size) {
      unchangedFields.push('email');
    } else if (overlap.length === 0) {
      const oStr = Array.from(oldEmails.primary).join(', ');
      const nStr = Array.from(newEmails.primary).join(', ');
      changes.push({
        field: 'email',
        change_type: 'modified',
        old_value: oStr,
        new_value: nStr,
        description: `Contact email address changed from ${oStr} to ${nStr}.`,
        tier: 'alert_if_confirmed',
        needs_confirmation: true,
        confidence: 0.9,
        evidence: 'Zero overlap in primary contact emails',
        change_id: hashChange(domain, 'email', nStr)
      });
    } else {
      const nStr = Array.from(newEmails.primary).join(', ');
      changes.push({
        field: 'email',
        change_type: 'partial_update',
        old_value: Array.from(oldEmails.primary).join(', '),
        new_value: nStr,
        description: `Contact email list updated (${nStr}).`,
        tier: 'log_only',
        needs_confirmation: false,
        confidence: 0.8,
        evidence: 'Partial overlap in emails',
        change_id: hashChange(domain, 'email', nStr)
      });
    }
  }

  // 8. SOCIAL FOOTPRINT
  const oldSocial = extractSocialFootprint(oldRec);
  const newSocial = extractSocialFootprint(newRec);

  for (const [platform, newHandle] of Object.entries(newSocial)) {
    const oldHandle = oldSocial[platform];
    if (!oldHandle) {
      changes.push({
        field: `social_${platform}`,
        change_type: 'added',
        old_value: null,
        new_value: newHandle,
        description: `New ${platform} profile added (${newHandle}).`,
        tier: 'log_only',
        needs_confirmation: false,
        confidence: 0.8,
        evidence: `Discovered profile on ${platform}`,
        change_id: hashChange(domain, `social_${platform}`, newHandle)
      });
    } else if (oldHandle.toLowerCase() !== newHandle.toLowerCase()) {
      changes.push({
        field: `social_${platform}`,
        change_type: 'modified',
        old_value: oldHandle,
        new_value: newHandle,
        description: `${platform} handle changed from "${oldHandle}" to "${newHandle}".`,
        tier: 'alert_if_confirmed',
        needs_confirmation: true,
        confidence: 0.85,
        evidence: `Handle modification on ${platform}`,
        change_id: hashChange(domain, `social_${platform}`, newHandle)
      });
    } else {
      unchangedFields.push(`social_${platform}`);
    }
  }

  // 9. SPECIAL LINKS & CAREERS
  const oldCareer = extractCareerLink(oldRec);
  const newCareer = extractCareerLink(newRec);

  if (oldCareer && newCareer) {
    const oldATS = classifyCareerLink(oldCareer);
    const newATS = classifyCareerLink(newCareer);

    if (oldATS !== newATS && newATS !== 'internal') {
      changes.push({
        field: 'career_portal',
        change_type: 'career_ats_changed',
        old_value: oldCareer,
        new_value: newCareer,
        description: `Recruitment portal shifted to ${newATS} (${newCareer}).`,
        tier: 'alert_if_confirmed',
        needs_confirmation: true,
        confidence: 0.9,
        evidence: `Hiring ATS changed from ${oldATS} to ${newATS}`,
        change_id: hashChange(domain, 'career_portal', newCareer)
      });
    } else if (normalizeUrl(oldCareer) !== normalizeUrl(newCareer)) {
      changes.push({
        field: 'career_portal',
        change_type: 'modified',
        old_value: oldCareer,
        new_value: newCareer,
        description: `Career page link changed to ${newCareer}.`,
        tier: 'log_only',
        needs_confirmation: false,
        confidence: 0.7,
        evidence: 'Career link path changed',
        change_id: hashChange(domain, 'career_portal', newCareer)
      });
    } else {
      unchangedFields.push('career_portal');
    }
  } else if (!oldCareer && newCareer) {
    if (baselineQuality.level === 'low') {
      baselineGaps.push({
        field: 'career_portal',
        change_type: 'baseline_gap',
        tier: 'log_only',
        evidence: `Career link ${newCareer} discovered, but baseline had no career links`
      });
    } else {
      changes.push({
        field: 'career_portal',
        change_type: 'added',
        old_value: null,
        new_value: newCareer,
        description: `Career link discovered: ${newCareer}.`,
        tier: 'log_only',
        needs_confirmation: false,
        confidence: 0.7,
        evidence: `New career link ${newCareer} without prior baseline`,
        change_id: hashChange(domain, 'career_portal', newCareer)
      });
    }
  }

  // 9b. OTHER LINKS (contactUs, blog, career, team)
  const otherKeys = ['contactUs', 'blog', 'career', 'team'];
  const oldOther = (oldRec.otherLinks && typeof oldRec.otherLinks === 'object') ? oldRec.otherLinks : {};
  const newOther = (newRec.otherLinks && typeof newRec.otherLinks === 'object') ? newRec.otherLinks : {};

  for (const k of otherKeys) {
    const oVal = oldOther[k];
    const nVal = newOther[k];
    if (oVal && nVal) {
      if (normalizeUrl(oVal) !== normalizeUrl(nVal)) {
        changes.push({
          field: `otherLinks.${k}`,
          change_type: 'modified',
          old_value: oVal,
          new_value: nVal,
          description: `otherLinks.${k} moved from ${oVal} to ${nVal}.`,
          tier: 'log_only',
          needs_confirmation: false,
          confidence: 0.8,
          evidence: `otherLinks.${k} modified from ${oVal} to ${nVal}`,
          change_id: hashChange(domain, `otherLinks.${k}`, nVal)
        });
      } else {
        unchangedFields.push(`otherLinks.${k}`);
      }
    } else if (oVal && !nVal) {
      changes.push({
        field: `otherLinks.${k}`,
        change_type: 'removed',
        old_value: oVal,
        new_value: null,
        description: `otherLinks.${k} link removed.`,
        tier: 'log_only',
        needs_confirmation: false,
        confidence: 0.8,
        evidence: `otherLinks.${k} removed`,
        change_id: hashChange(domain, `otherLinks.${k}`, 'removed')
      });
    } else if (!oVal && nVal) {
      if (baselineQuality.level === 'low') {
        baselineGaps.push({
          field: `otherLinks.${k}`,
          change_type: 'baseline_gap',
          tier: 'log_only',
          evidence: `otherLinks.${k} populated in live crawl but missing in baseline`
        });
      } else {
        changes.push({
          field: `otherLinks.${k}`,
          change_type: 'added',
          old_value: null,
          new_value: nVal,
          description: `otherLinks.${k} added: ${nVal}.`,
          tier: 'log_only',
          needs_confirmation: false,
          confidence: 0.8,
          evidence: `otherLinks.${k} discovered: ${nVal}`,
          change_id: hashChange(domain, `otherLinks.${k}`, nVal)
        });
      }
    }
  }

  // 10. SUBDOMAINS
  const oldSubdomains = extractSubdomains(oldRec, domain);
  const newSubdomains = extractSubdomains(newRec, domain);

  const addedSubdomains = Array.from(newSubdomains).filter(s => !oldSubdomains.has(s));
  const removedSubdomains = Array.from(oldSubdomains).filter(s => !newSubdomains.has(s));

  for (const sub of addedSubdomains) {
    const subTier = isCoverageImbalanced ? 'log_only' : 'alert_if_confirmed';
    changes.push({
      field: 'subdomain',
      change_type: 'added',
      old_value: null,
      new_value: `${sub}.${domain}`,
      description: `New business subdomain discovered: ${sub}.${domain}.`,
      tier: subTier,
      needs_confirmation: !isCoverageImbalanced,
      confidence: isCoverageImbalanced ? 0.6 : 0.9,
      evidence: isCoverageImbalanced
        ? `Discovered new active host ${sub}.${domain} (downgraded due to coverage_difference: ratio ${coverageRatio})`
        : `Discovered new active host ${sub}.${domain}`,
      ...(isCoverageImbalanced ? { reason: 'coverage_difference' } : {}),
      change_id: hashChange(domain, 'subdomain', `${sub}.${domain}`)
    });
  }

  for (const sub of removedSubdomains) {
    changes.push({
      field: 'subdomain',
      change_type: 'removed',
      old_value: `${sub}.${domain}`,
      new_value: null,
      description: `Subdomain ${sub}.${domain} no longer referenced.`,
      tier: 'log_only',
      needs_confirmation: false,
      confidence: 0.7,
      evidence: isCoverageImbalanced
        ? `Subdomain disappeared from link pool (coverage_difference: ratio ${coverageRatio})`
        : `Subdomain disappeared from link pool`,
      ...(isCoverageImbalanced ? { reason: 'coverage_difference' } : {}),
      change_id: hashChange(domain, 'subdomain_removed', `${sub}.${domain}`)
    });
  }

  // 11. LOGO IMAGE
  if (oldRec.imageUrl && newRec.imageUrl) {
    const oldBase = path.basename(oldRec.imageUrl.split('?')[0]);
    const newBase = path.basename(newRec.imageUrl.split('?')[0]);
    if (oldBase !== newBase) {
      changes.push({
        field: 'logo',
        change_type: 'modified',
        old_value: oldRec.imageUrl,
        new_value: newRec.imageUrl,
        description: 'Company logo graphic updated.',
        tier: 'log_only',
        needs_confirmation: false,
        confidence: 0.75,
        evidence: `Logo filename changed from ${oldBase} to ${newBase}`,
        change_id: hashChange(domain, 'logo', newRec.imageUrl)
      });
    } else if (oldRec.imageUrl !== newRec.imageUrl) {
      addNoise('imageUrl', oldRec.imageUrl, newRec.imageUrl, 'cosmetic: query param / hash change');
    } else {
      unchangedFields.push('imageUrl');
    }
  }

  // 12. ADDRESS & POSTCODE
  const oldPostcodes = extractPostcodes(oldRec);
  const newPostcodes = extractPostcodes(newRec);

  let changedPostcodeSources = 0;
  let sampleOldPostcode = null;
  let sampleNewPostcode = null;

  for (const src of ['contactPage', 'mapsLink', 'aboutPage', 'legalPage']) {
    const oP = oldPostcodes[src];
    const nP = newPostcodes[src];
    if (oP && nP) {
      if (oP !== nP) {
        changedPostcodeSources++;
        sampleOldPostcode = oP;
        sampleNewPostcode = nP;
      }
    }
  }

  if (changedPostcodeSources >= 2) {
    changes.push({
      field: 'address',
      change_type: 'office_relocated',
      old_value: sampleOldPostcode,
      new_value: sampleNewPostcode,
      description: `Company registered office relocated (postcode changed from ${sampleOldPostcode} to ${sampleNewPostcode}).`,
      tier: 'alert',
      needs_confirmation: false,
      confidence: 0.95,
      evidence: `Postcode changed across ${changedPostcodeSources} independent sources (including maps/contact)`,
      change_id: hashChange(domain, 'address', sampleNewPostcode)
    });
  } else if (changedPostcodeSources === 1) {
    changes.push({
      field: 'address',
      change_type: 'office_relocated',
      old_value: sampleOldPostcode,
      new_value: sampleNewPostcode,
      description: `Possible office relocation detected (postcode changed to ${sampleNewPostcode} on contact page).`,
      tier: 'alert_if_confirmed',
      needs_confirmation: true,
      confidence: 0.8,
      evidence: `Postcode changed in 1 source`,
      change_id: hashChange(domain, 'address', sampleNewPostcode)
    });
  } else if (Object.keys(oldPostcodes).length === 0 && Object.keys(newPostcodes).length > 0) {
    const oldPagesMissing = (!oldRec.contactPage || !oldRec.contactPage.trim()) && (!oldRec.aboutPage || !oldRec.aboutPage.trim()) && !oldRec.address && !oldRec.postal_code;
    const newPc = Object.values(newPostcodes)[0];
    if (oldPagesMissing) {
      baselineGaps.push({
        field: 'address',
        change_type: 'baseline_gap',
        old_value: null,
        new_value: newPc,
        description: `Address/postcode discovered from newly crawled page (${newPc}).`,
        tier: 'log_only',
        needs_confirmation: false,
        confidence: 0.8,
        evidence: 'Baseline page bodies were missing in old crawl; address extracted from new crawl',
        change_id: hashChange(domain, 'address', newPc)
      });
    }
  }

  // 13. LEGAL ENTITY REGISTRATION NUMBER
  const oldReg = extractRegistration(oldRec);
  const newReg = extractRegistration(newRec);

  if (oldReg && newReg) {
    if (oldReg.number !== newReg.number) {
      changes.push({
        field: 'legal_registration_number',
        change_type: 'modified',
        old_value: oldReg.number,
        new_value: newReg.number,
        description: `Company registration number changed from ${oldReg.number} to ${newReg.number}.`,
        tier: 'alert',
        needs_confirmation: false,
        confidence: 0.95,
        evidence: `Official registration identifier modified`,
        change_id: hashChange(domain, 'legal_registration_number', newReg.number)
      });
    } else {
      unchangedFields.push('legal_registration_number');
      unchangedFields.push('registration_number');
    }
  } else if (!oldReg && newReg) {
    unchangedFields.push('registration_number');
  }

  // 14. UNKNOWN FIELDS (Rule 7: always log_only)
  for (const [k, v] of Object.entries(newRec)) {
    if (CONFIG.KNOWN_FIELDS.includes(k) || CONFIG.VOLATILE_FIELDS.includes(k)) continue;
    const oldV = oldRec[k];
    if (oldV === undefined || oldV === null) {
      changes.push({
        field: k,
        change_type: 'added',
        old_value: null,
        new_value: typeof v === 'object' ? JSON.stringify(v) : String(v),
        description: `Custom field "${k}" added.`,
        tier: 'log_only',
        needs_confirmation: false,
        confidence: 0.6,
        evidence: 'Unknown schema property discovered in new crawl',
        change_id: hashChange(domain, k, String(v))
      });
    }
  }

  // 15. CHECK FOR DROPPED SCALAR FIELDS (Missing is not removed -> not_found_fields)
  for (const [k, v] of Object.entries(oldRec)) {
    if (CONFIG.VOLATILE_FIELDS.includes(k)) continue;
    if (k === 'registration_number' && newReg) continue;
    if ((k === 'address' || k === 'postal_code') && Object.keys(newPostcodes).length > 0) continue;
    if (v !== null && v !== undefined && String(v).trim() !== '') {
      const nv = newRec[k];
      if (nv === null || nv === undefined || String(nv).trim() === '') {
        if (!notFoundFields.includes(k)) {
          notFoundFields.push(k);
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // STATE TRACKING FILTER (Item 6)
  // --------------------------------------------------------------------------
  const sentChangeIds = options.sentChangeIds instanceof Set
    ? options.sentChangeIds
    : new Set(
        Array.isArray(options.sentChangeIds)
          ? options.sentChangeIds
          : (options.sentChangeIds ? Object.keys(options.sentChangeIds) : [])
      );

  if (sentChangeIds.size > 0) {
    for (const c of changes) {
      if (sentChangeIds.has(c.change_id)) {
        c.already_reported = true;
        if (c.tier === 'alert' || c.tier === 'alert_if_confirmed') {
          c.tier = 'log_only';
          c.needs_confirmation = false;
          c.evidence = `${c.evidence || ''} (already reported previously)`.trim();
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // BASELINE QUALITY CAPPING (Item 3)
  // --------------------------------------------------------------------------
  const isHardEvent = changes.some(c => {
    if (c.field === 'redirection' && c.change_type === 'domain_redirect') return true;
    if (c.field === 'website_status' && c.change_type === 'offline_or_parked') return true;
    if (c.field === 'legal_registration_number' && c.change_type === 'modified') return true;
    if (c.field === 'address' && c.change_type === 'office_relocated' && c.tier === 'alert' && (oldRec.address || oldRec.postal_code)) return true;
    return false;
  });

  let recommendation = null;
  if (baselineQuality.level === 'low') {
    recommendation = 'refresh baseline from a live crawl (--accept)';
    const contentFields = [
      'catalog', 'description', 'title', 'subdomain', 'subdomain_added', 'subdomain_removed',
      'email', 'social', 'phone', 'content_links', 'nameFromTitle'
    ];
    for (const c of changes) {
      if (contentFields.includes(c.field) || c.field.startsWith('socialLinks')) {
        if (c.tier === 'alert' || c.tier === 'alert_if_confirmed') {
          c.tier = 'log_only';
          c.needs_confirmation = false;
          c.evidence = `${c.evidence || ''} (capped at log_only due to low baseline quality)`.trim();
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // SUMMARY & METRICS
  // --------------------------------------------------------------------------
  let hasAlert = changes.some(c => c.tier === 'alert');
  let hasPending = changes.some(c => c.tier === 'alert_if_confirmed');

  if (baselineQuality.level === 'low' && !isHardEvent) {
    hasAlert = false;
    hasPending = false;
  }

  let summary = 'No meaningful business changes detected between crawls.';
  if (hasAlert) {
    const alertFields = changes
      .filter(c => c.tier === 'alert')
      .map(c => c.field);
    summary = `Meaningful business changes detected: ${Array.from(new Set(alertFields)).join(', ')}.`;
  } else if (hasPending) {
    const pendingFields = changes
      .filter(c => c.tier === 'alert_if_confirmed')
      .map(c => c.field);
    summary = `Pending confirmation changes detected: ${Array.from(new Set(pendingFields)).join(', ')}.`;
  } else if (changes.length > 0) {
    summary = `Minor updates logged (${changes.length} low-priority adjustments).`;
  }

  return {
    domain,
    compared_at: new Date().toISOString(),
    baseline_crawled_at: baselineCrawledAt,
    baseline_age_days: baselineAgeDays,
    status: 'ok',
    baseline_quality: baselineQuality,
    baseline_gaps: baselineGaps,
    ...(recommendation ? { recommendation } : {}),
    has_meaningful_change: hasAlert,
    has_pending_confirmation: hasPending,
    summary,
    coverage,
    changes,
    noise_detected: noiseDetected,
    unchanged_fields: Array.from(new Set(unchangedFields)),
    not_found_fields: Array.from(new Set(notFoundFields))
  };
}

/**
 * Pure helper returning changes that reproduce across two crawl results.
 * @param {object} firstResult
 * @param {object} confirmationResult
 * @returns {Array<object>} array of confirmed change objects
 */
function confirmChanges(firstResult, confirmationResult) {
  if (!firstResult?.changes || !confirmationResult?.changes) return [];
  const confirmed = [];
  for (const c1 of firstResult.changes) {
    if (c1.tier !== 'alert_if_confirmed' && !c1.needs_confirmation) continue;
    const match = confirmationResult.changes.find(
      c2 => c2.field === c1.field &&
            c2.change_type === c1.change_type &&
            c2.change_id === c1.change_id
    );
    if (match) {
      confirmed.push({
        ...c1,
        tier: 'alert',
        needs_confirmation: false,
        confirmed: true,
        confirmed_at: new Date().toISOString()
      });
    }
  }
  return confirmed;
}

/**
 * Evaluates stability between two consecutive crawls of the same domain.
 * Any change with tier alert or alert_if_confirmed is classified as a FALSE POSITIVE.
 * @param {object} crawl1
 * @param {object} crawl2
 * @returns {object} stability evaluation
 */
function evaluateStability(crawl1, crawl2) {
  const comp = compareCrawls(crawl1, crawl2);
  const falsePositives = (comp.changes || []).filter(
    c => c.tier === 'alert' || c.tier === 'alert_if_confirmed'
  );
  const logOnly = (comp.changes || []).filter(c => c.tier === 'log_only');
  return {
    domain: comp.domain,
    status: comp.status,
    is_stable: falsePositives.length === 0,
    false_positives: falsePositives,
    log_only: logOnly,
    comparison: comp
  };
}

/**
 * Classifies error into standardized reason slugs.
 * (timeout, http_<code>, dns_error, invalid_json, empty_crawl_data)
 * @param {Error|string} err
 * @returns {string} reason slug
 */
function classifyErrorReason(err) {
  if (!err) return 'unknown_error';
  const msg = (typeof err === 'string' ? err : err.message || '').toLowerCase();

  if (msg.includes('time') && (msg.includes('out') || msg.includes('etimedout') || msg.includes('timeout'))) {
    return 'timeout';
  }
  const httpMatch = msg.match(/(?:http|status|code)\s*[:=]?\s*([45]\d{2})/i) || msg.match(/\b([45]\d{2})\b/);
  if (httpMatch) {
    return `http_${httpMatch[1]}`;
  }
  if (msg.includes('enotfound') || msg.includes('eai_again') || msg.includes('dns') || msg.includes('getaddrinfo')) {
    return 'dns_error';
  }
  if (msg.includes('json') || msg.includes('syntaxerror') || msg.includes('unexpected token')) {
    return 'invalid_json';
  }
  if (msg.includes('empty') || msg.includes('no crawl records')) {
    return 'empty_crawl_data';
  }
  return 'crawl_failed';
}

/**
 * Retries timeouts once with 1.5x timeout.
 */
async function fetchCrawlWithRetry(domain, baseTimeoutMs = 120000) {
  try {
    return await crawlerService.crawlDomain(domain, { timeoutMs: baseTimeoutMs });
  } catch (err) {
    const reason = classifyErrorReason(err);
    if (reason === 'timeout') {
      const retryTimeoutMs = Math.round(baseTimeoutMs * 1.5);
      console.log(`[CrawlerService] ${domain} timed out after ${baseTimeoutMs}ms. Retrying once with 1.5x timeout (${retryTimeoutMs}ms)...`);
      return await crawlerService.crawlDomain(domain, { timeoutMs: retryTimeoutMs });
    }
    console.log(`[CrawlerService] ${domain} failed (${reason}). Retrying once...`);
    await new Promise(r => setTimeout(r, 1500));
    return await crawlerService.crawlDomain(domain, { timeoutMs: baseTimeoutMs });
  }
}

const STATE_DIR = path.resolve(process.cwd(), 'data', 'state');
const SENT_STATE_FILE = path.join(STATE_DIR, 'sent_change_ids.json');

function loadSentChangeIds() {
  if (fs.existsSync(SENT_STATE_FILE)) {
    try {
      const raw = fs.readFileSync(SENT_STATE_FILE, 'utf8');
      const data = JSON.parse(raw);
      if (typeof data === 'object' && data !== null) return data;
    } catch {}
  }
  return {};
}

function markChangeIdsReported(changes, domain) {
  const state = loadSentChangeIds();
  let modified = false;
  for (const c of changes) {
    if (c.change_id && (c.tier === 'alert' || c.confirmed)) {
      if (!state[c.change_id]) {
        state[c.change_id] = {
          domain,
          field: c.field,
          change_type: c.change_type,
          reported_at: new Date().toISOString()
        };
        modified = true;
      }
    }
  }
  if (modified) {
    atomicWriteJson(SENT_STATE_FILE, state);
  }
}

// ============================================================================
// I/O & RESULTS STORAGE
// ============================================================================

/**
 * Atomically writes JSON file using temp file and rename.
 */
function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tempPath = path.join(dir, `.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

/**
 * Reads an old JSON snapshot file and attaches _file_mtime if no timestamp is present.
 */
function readOldJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === 'object') {
    try {
      const stats = fs.statSync(filePath);
      if (!parsed.saved_at && !parsed.created_at && !parsed.crawled_at) {
        parsed._file_mtime = stats.mtime.toISOString();
      }
    } catch {}
  }
  return parsed;
}

/**
 * Atomically records or updates a domain result in results/comparison_results.json
 */
function recordResult(resultEntry) {
  const resultsPath = path.resolve(process.cwd(), 'results', 'comparison_results.json');
  let results = [];
  if (fs.existsSync(resultsPath)) {
    try {
      const raw = fs.readFileSync(resultsPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) results = parsed;
    } catch {
      results = [];
    }
  }

  const idx = results.findIndex(r => r.domain === resultEntry.domain);
  if (idx >= 0) {
    results[idx] = resultEntry;
  } else {
    results.push(resultEntry);
  }

  atomicWriteJson(resultsPath, results);
}

// ============================================================================
// SELFTEST MUTATIONS
// ============================================================================

function runSelfTest() {
  console.log('--- Running SelfTest Mutation Suite (16 cases) ---\n');

  // Load infynd baseline as testing canvas
  let baseJson = null;
  const oldPath = path.resolve(process.cwd(), 'data', 'old', 'infynd.com.json');
  if (fs.existsSync(oldPath)) {
    baseJson = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
  } else {
    baseJson = {
      crawl_data: {
        status: 1,
        data: [{
          normalizedDomain: 'infynd.com',
          url: 'https://infynd.com',
          responseCode: '200',
          domainStatus: 'Valid',
          title: 'InFynd Group | Data & AI Platforms',
          description: 'InFynd Group is a family of data platforms.',
          homeContent: 'InFynd Group Data and AI platforms for B2B Healthcare and Risk intelligence.',
          nameFromTitle: 'InFynd Group',
          clearbitName: 'Infynd',
          phone: null,
          contactPage: 'Contact us Phone +44 3338 980725 Lily Hill House RG12 2SJ Company No. 12150394 marketing@infynd.com',
          homeLinks: '[https://www.google.com/maps/search/?api=1&query=Lily+Hill+House+Bracknell+RG12+2SJ, https://x.com/infynd_data]'
        }]
      }
    };
  }

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  const tests = [
    {
      id: 1,
      name: 'new responseCode "403": inconclusive',
      fn: () => {
        const oldC = clone(baseJson);
        const newC = clone(baseJson);
        newC.crawl_data.data[0].responseCode = '403';
        const res = compareCrawls(oldC, newC);
        return res.status === 'inconclusive' && res.reason === 'http_403';
      }
    },
    {
      id: 2,
      name: 'homeContent shortened to under 30%: inconclusive',
      fn: () => {
        const oldC = clone(baseJson);
        const newC = clone(baseJson);
        newC.crawl_data.data[0].homeContent = 'Short.';
        const res = compareCrawls(oldC, newC);
        return res.status === 'inconclusive' && res.reason === 'js_rendering_required';
      }
    },
    {
      id: 3,
      name: 'phone found only in contactPage changed to a different valid number: alert phone_modified',
      fn: () => {
        const oldC = clone(baseJson);
        const newC = clone(baseJson);
        oldC.crawl_data.data[0].phone = null;
        oldC.crawl_data.data[0].phoneFormatted = null;
        oldC.crawl_data.data[0].aboutPage = '';
        oldC.crawl_data.data[0].contactPage = 'Call us at +44 20 8089 2420.';
        newC.crawl_data.data[0].phone = '+44 3338 980725';
        newC.crawl_data.data[0].phoneFormatted = null;
        newC.crawl_data.data[0].aboutPage = '';
        newC.crawl_data.data[0].contactPage = 'Call us at +44 3338 980725.';
        const res = compareCrawls(oldC, newC);
        const pChange = res.changes.find(c => c.field === 'phone');
        return pChange && pChange.tier === 'alert' && pChange.change_type === 'modified';
      }
    },
    {
      id: 4,
      name: 'phone was null and number only moves from contactPage to phone (same number): unchanged',
      fn: () => {
        const oldC = clone(baseJson);
        const newC = clone(baseJson);
        oldC.crawl_data.data[0].phone = null;
        oldC.crawl_data.data[0].contactPage = 'Call +44 3338 980725';
        newC.crawl_data.data[0].phone = '+44 3338 980725';
        newC.crawl_data.data[0].contactPage = 'General enquiry';
        const res = compareCrawls(oldC, newC);
        const pChange = res.changes.find(c => c.field === 'phone');
        return !pChange;
      }
    },
    {
      id: 5,
      name: 'contactPage postcode changed alone (alert_if_confirmed); plus Maps link changed (alert office_relocated)',
      fn: () => {
        const oldC = clone(baseJson);
        oldC.crawl_data.data[0].contactPage = 'Lily Hill Road, Bracknell, RG12 2SJ';
        oldC.crawl_data.data[0].homeLinks = '[https://www.google.com/maps/search/?api=1&query=Bracknell+RG12+2SJ]';
        oldC.crawl_data.data[0].aboutPage = '';

        // Part A: contactPage alone changed
        const newA = clone(oldC);
        newA.crawl_data.data[0].contactPage = 'Lily Hill Road, Bracknell, SW1A 1AA';
        const resA = compareCrawls(oldC, newA);
        const changeA = resA.changes.find(c => c.field === 'address');
        const passA = changeA && changeA.tier === 'alert_if_confirmed';

        // Part B: contactPage + maps link changed
        const newB = clone(oldC);
        newB.crawl_data.data[0].contactPage = 'Lily Hill Road, Bracknell, SW1A 1AA';
        newB.crawl_data.data[0].homeLinks = '[https://www.google.com/maps/search/?api=1&query=London+SW1A+1AA]';
        const resB = compareCrawls(oldC, newB);
        const changeB = resB.changes.find(c => c.field === 'address');
        const passB = changeB && changeB.tier === 'alert' && changeB.change_type === 'office_relocated';

        return passA && passB;
      }
    },
    {
      id: 6,
      name: 'nameFromTitle & clearbitName changed to new brand: alert rebrand; only nameFromTitle: log_only',
      fn: () => {
        const oldC = clone(baseJson);
        // Part A: Both changed
        const newA = clone(baseJson);
        newA.crawl_data.data[0].nameFromTitle = 'Acme Technologies';
        newA.crawl_data.data[0].clearbitName = 'Acme Ltd';
        const resA = compareCrawls(oldC, newA);
        const changeA = resA.changes.find(c => c.field === 'company_name');
        const passA = changeA && changeA.tier === 'alert' && changeA.change_type === 'rebrand';

        // Part B: Only nameFromTitle changed
        const newB = clone(baseJson);
        newB.crawl_data.data[0].nameFromTitle = 'Acme Technologies';
        newB.crawl_data.data[0].clearbitName = 'Infynd'; // unchanged stem
        const resB = compareCrawls(oldC, newB);
        const changeB = resB.changes.find(c => c.field === 'company_name');
        const passB = changeB && changeB.tier === 'log_only';

        return passA && passB;
      }
    },
    {
      id: 7,
      name: 'only description rewritten: log_only; with serviceLinks + homeContent themes: alert_if_confirmed',
      fn: () => {
        const oldC = clone(baseJson);
        // Part A: description alone
        const newA = clone(baseJson);
        newA.crawl_data.data[0].description = 'Completely unique revolutionized drone navigation platform.';
        const resA = compareCrawls(oldC, newA);
        const changeA = resA.changes.find(c => c.field === 'description');
        const passA = changeA && changeA.tier === 'log_only';

        // Part B: corroborated (maintain length > 30% to not trigger js_rendering_required)
        const newB = clone(baseJson);
        newB.crawl_data.data[0].description = 'Completely unique revolutionized drone navigation platform.';
        newB.crawl_data.data[0].serviceLinks = '["https://infynd.com/autonomous-drone-ai"]';
        newB.crawl_data.data[0].homeContent = 'Autonomous drone fleet navigation, aviation sensor intelligence, aerial robotics flight controller. '.repeat(4);
        const resB = compareCrawls(oldC, newB);
        const changeB = resB.changes.find(c => c.field === 'description');
        const passB = changeB && changeB.tier === 'alert_if_confirmed';

        return passA && passB;
      }
    },
    {
      id: 8,
      name: 'new /blog/... link only: no alert',
      fn: () => {
        const oldC = clone(baseJson);
        const newC = clone(baseJson);
        newC.crawl_data.data[0].productLinks = '["https://infynd.com/blog/how-to-scale-sales"]';
        const res = compareCrawls(oldC, newC);
        return !res.has_meaningful_change;
      }
    },
    {
      id: 9,
      name: 'new subdomain portal.<domain>: alert_if_confirmed; cdn.<domain>: ignored; app.otherdomain.com: ignored',
      fn: () => {
        const oldC = clone(baseJson);
        const newC = clone(baseJson);
        newC.crawl_data.data[0].homeLinks = [
          ...extractUrls(oldC.crawl_data.data[0].homeLinks),
          'https://portal.infynd.com/login',
          'https://cdn.infynd.com/bundle.js',
          'https://app.otherdomain.com/dashboard'
        ];
        const res = compareCrawls(oldC, newC);
        const subChanges = res.changes.filter(c => c.field === 'subdomain');
        const hasPortal = subChanges.some(c => c.new_value === 'portal.infynd.com' && c.tier === 'alert_if_confirmed');
        const hasCdn = subChanges.some(c => c.new_value.includes('cdn'));
        const hasOther = subChanges.some(c => c.new_value.includes('otherdomain'));
        return hasPortal && !hasCdn && !hasOther;
      }
    },
    {
      id: 10,
      name: 'email field replaced with different address: alert_if_confirmed; one extra email: log_only',
      fn: () => {
        const oldA = clone(baseJson);
        oldA.crawl_data.data[0].email = 'sales@infynd.com';
        oldA.crawl_data.data[0].genericEmail = null;
        oldA.crawl_data.data[0].nonGenericEmail = null;
        oldA.crawl_data.data[0].contactPage = '';

        // Part A: Replaced entirely
        const newA = clone(baseJson);
        newA.crawl_data.data[0].email = 'support@infynd.com';
        newA.crawl_data.data[0].genericEmail = null;
        newA.crawl_data.data[0].nonGenericEmail = null;
        newA.crawl_data.data[0].contactPage = '';
        const resA = compareCrawls(oldA, newA);
        const changeA = resA.changes.find(c => c.field === 'email');
        const passA = changeA && changeA.tier === 'alert_if_confirmed';

        // Part B: Extra email added
        const newB = clone(baseJson);
        newB.crawl_data.data[0].email = 'sales@infynd.com, billing@infynd.com';
        newB.crawl_data.data[0].genericEmail = null;
        newB.crawl_data.data[0].nonGenericEmail = null;
        newB.crawl_data.data[0].contactPage = '';
        const resB = compareCrawls(oldA, newB);
        const changeB = resB.changes.find(c => c.field === 'email');
        const passB = changeB && changeB.tier === 'log_only';

        return passA && passB;
      }
    },
    {
      id: 11,
      name: 'otherLinks.career moved to jobs.lever.co/...: alert_if_confirmed',
      fn: () => {
        const oldC = clone(baseJson);
        const newC = clone(baseJson);
        oldC.crawl_data.data[0].otherLinks = { career: 'https://infynd.com/careers' };
        newC.crawl_data.data[0].otherLinks = { career: 'https://jobs.lever.co/infynd' };
        const res = compareCrawls(oldC, newC);
        const change = res.changes.find(c => c.field === 'career_portal');
        return change && change.tier === 'alert_if_confirmed' && change.change_type === 'career_ats_changed';
      }
    },
    {
      id: 12,
      name: 'socialLinks.twitter set to twitter.com/<same handle as x.com in homeLinks>: unchanged',
      fn: () => {
        const oldC = clone(baseJson);
        const newC = clone(baseJson);
        oldC.crawl_data.data[0].homeLinks = '[https://x.com/infynd_data]';
        newC.crawl_data.data[0].socialLinks = { twitter: 'https://twitter.com/infynd_data' };
        const res = compareCrawls(oldC, newC);
        const twitterChange = res.changes.find(c => c.field.includes('twitter'));
        return !twitterChange;
      }
    },
    {
      id: 13,
      name: 'company registration number changed: alert',
      fn: () => {
        const oldC = clone(baseJson);
        const newC = clone(baseJson);
        oldC.crawl_data.data[0].privacyPage = 'Company No. 12150394';
        oldC.crawl_data.data[0].contactPage = '';
        newC.crawl_data.data[0].privacyPage = 'Company No. 98765432';
        newC.crawl_data.data[0].contactPage = '';
        const res = compareCrawls(oldC, newC);
        const change = res.changes.find(c => c.field === 'legal_registration_number');
        return change && change.tier === 'alert';
      }
    },
    {
      id: 14,
      name: 'field with value in old and null in new: not_found_fields, no alert',
      fn: () => {
        const oldC = clone(baseJson);
        const newC = clone(baseJson);
        oldC.crawl_data.data[0].nameFromCopyright = 'InFynd Ltd';
        newC.crawl_data.data[0].nameFromCopyright = null;
        const res = compareCrawls(oldC, newC);
        const hasNotFound = res.not_found_fields.includes('nameFromCopyright');
        const hasAlert = res.changes.some(c => c.field === 'nameFromCopyright' && c.tier === 'alert');
        return hasNotFound && !hasAlert;
      }
    },
    {
      id: 15,
      name: 'unknown extra field added to new record: log_only',
      fn: () => {
        const oldC = clone(baseJson);
        const newC = clone(baseJson);
        newC.crawl_data.data[0].customFundingRound = 'Series B $45M';
        const res = compareCrawls(oldC, newC);
        const change = res.changes.find(c => c.field === 'customFundingRound');
        return change && change.tier === 'log_only';
      }
    },
    {
      id: 16,
      name: 'homeLinks converted between bracket-string and array with same URLs: unchanged',
      fn: () => {
        const oldC = clone(baseJson);
        const newC = clone(baseJson);
        oldC.crawl_data.data[0].homeLinks = '[https://infynd.com/about, https://infynd.com/pricing]';
        newC.crawl_data.data[0].homeLinks = ['https://infynd.com/about', 'https://infynd.com/pricing'];
        const res = compareCrawls(oldC, newC);
        return !res.changes.some(c => c.field === 'homeLinks');
      }
    },
    {
      id: 17,
      name: 'redirect: apex to www does normal comparison; external domain alerts and skips fields',
      fn: () => {
        // Part A: whitesbodyworks.com -> www.whitesbodyworks.com (same registrable domain)
        const oldA = {
          data: [{
            normalizedDomain: 'whitesbodyworks.com',
            url: 'https://whitesbodyworks.com/',
            responseCode: '200',
            domainStatus: 'Valid',
            title: 'White Bodyworks',
            homeContent: 'Welcome to White Bodyworks automobile repair services. '.repeat(5)
          }]
        };
        const newA = {
          data: [{
            normalizedDomain: 'whitesbodyworks.com',
            url: 'https://www.whitesbodyworks.com/',
            redirection: 'true',
            responseCode: '200',
            domainStatus: 'Valid',
            title: 'White Bodyworks',
            homeContent: 'Welcome to White Bodyworks automobile repair services. '.repeat(5)
          }]
        };
        const resA = compareCrawls(oldA, newA);
        const hasRedirA = resA.changes.some(c => c.field === 'redirection');
        const normalCompRan = resA.unchanged_fields.includes('title');

        // Part B: example.com -> otherbrand.com (different registrable domain)
        const oldB = {
          data: [{
            normalizedDomain: 'example.com',
            url: 'https://example.com/',
            responseCode: '200',
            domainStatus: 'Valid',
            title: 'Example',
            homeContent: 'Example content. '.repeat(5)
          }]
        };
        const newB = {
          data: [{
            normalizedDomain: 'example.com',
            url: 'https://otherbrand.com/',
            redirection: 'true',
            responseCode: '200',
            domainStatus: 'Valid',
            title: 'Other Brand',
            homeContent: 'Other brand content. '.repeat(5)
          }]
        };
        const resB = compareCrawls(oldB, newB);
        const redirChangeB = resB.changes.find(c => c.field === 'redirection');
        const passB = redirChangeB && redirChangeB.tier === 'alert' && redirChangeB.change_type === 'domain_redirect';

        return !hasRedirA && normalCompRan && passB;
      }
    },
    {
      id: 18,
      name: 'brand from title: picks best segment by domain/brand token overlap without brand_name_drift',
      fn: () => {
        const oldJson = {
          data: [{
            normalizedDomain: 'whitestudiolondon.com',
            companyName: 'White Studio Bridal',
            nameFromTitle: 'Wedding dress | White Studio Bridal | United Kingdom',
            title: 'Wedding dress | White Studio Bridal | United Kingdom'
          }]
        };
        const newJson = {
          data: [{
            normalizedDomain: 'whitestudiolondon.com',
            companyName: 'White Studio Bridal',
            nameFromTitle: 'White Studio Bridal',
            title: 'Wedding dress | White Studio Bridal | United Kingdom'
          }]
        };
        const res = compareCrawls(oldJson, newJson);
        const hasDrift = res.changes.some(c => c.field === 'company_name' || c.change_type === 'brand_name_drift');
        const hasNoise = res.noise_detected.some(n => n.field === 'nameFromTitle');
        return !hasDrift && hasNoise;
      }
    },
    {
      id: 19,
      name: 'route families & coverage guard: collapses /shop-N and downgrades when link ratio > 2.0 to log_only',
      fn: () => {
        // Old has 12 unique links
        const oldLinks = Array.from({ length: 12 }, (_, i) => `https://example.com/page-${i}`);
        // New has 40 unique links + 3 new routes: /shop-1, /shop-5, /shop-10
        const newLinks = Array.from({ length: 40 }, (_, i) => `https://example.com/item-${i}`);

        const oldJson = {
          data: [{
            normalizedDomain: 'example.com',
            homeLinks: JSON.stringify(oldLinks),
            productLinks: []
          }]
        };
        const newJson = {
          data: [{
            normalizedDomain: 'example.com',
            homeLinks: JSON.stringify(newLinks),
            productLinks: ['https://example.com/shop-1', 'https://example.com/shop-5', 'https://example.com/shop-10']
          }]
        };

        const res = compareCrawls(oldJson, newJson);
        const catChange = res.changes.find(c => c.field === 'catalog');
        const hasCoverage = res.coverage && res.coverage.ratio > 2.0;
        const isLogOnly = catChange && catChange.tier === 'log_only';
        const noMeaningful = !res.has_meaningful_change;

        return hasCoverage && isLogOnly && noMeaningful;
      }
    },
    {
      id: 20,
      name: 'phone corroboration: zero overlap with 1 source yields alert_if_confirmed; 2+ sources yields alert',
      fn: () => {
        const oldC = clone(baseJson);
        const new1 = clone(baseJson);
        oldC.crawl_data.data[0].phone = '+44 20 8089 2420';
        oldC.crawl_data.data[0].phoneFormatted = null;
        oldC.crawl_data.data[0].aboutPage = '';
        oldC.crawl_data.data[0].contactPage = 'Call +44 20 8089 2420';

        // 1 source: only in contactPage
        new1.crawl_data.data[0].phone = null;
        new1.crawl_data.data[0].phoneFormatted = null;
        new1.crawl_data.data[0].aboutPage = '';
        new1.crawl_data.data[0].contactPage = 'Call us at +44 3338 980725.';
        new1.crawl_data.data[0].homeLinks = [];
        const res1 = compareCrawls(oldC, new1);
        const pChange1 = res1.changes.find(c => c.field === 'phone');
        if (!pChange1 || pChange1.tier !== 'alert_if_confirmed' || !pChange1.needs_confirmation) {
          return false;
        }

        // 2 sources: contactPage + homeLinks tel: link
        const new2 = clone(new1);
        new2.crawl_data.data[0].homeLinks = ['tel:+443338980725'];
        const res2 = compareCrawls(oldC, new2);
        const pChange2 = res2.changes.find(c => c.field === 'phone');
        return pChange2 && pChange2.tier === 'alert' && !pChange2.needs_confirmation;
      }
    },
    {
      id: 21,
      name: 'output semantics: has_meaningful_change is true only for alert; has_pending_confirmation for alert_if_confirmed; baseline timestamps',
      fn: () => {
        const oldC = clone(baseJson);
        oldC.saved_at = '2026-10-01T00:00:00.000Z';
        const new1 = clone(baseJson);

        // Subdomain portal.infynd.com only -> alert_if_confirmed
        new1.crawl_data.data[0].homeLinks = [
          ...extractUrls(oldC.crawl_data.data[0].homeLinks),
          'https://portal.infynd.com/login'
        ];
        const res1 = compareCrawls(oldC, new1);
        if (res1.has_meaningful_change !== false) return false;
        if (res1.has_pending_confirmation !== true) return false;
        if (res1.baseline_crawled_at !== '2026-10-01T00:00:00.000Z') return false;
        if (typeof res1.baseline_age_days !== 'number' || res1.baseline_age_days < 0) return false;

        // Add phone change with 2 sources -> alert
        const new2 = clone(new1);
        oldC.crawl_data.data[0].phone = '+44 20 8089 2420';
        oldC.crawl_data.data[0].phoneFormatted = null;
        oldC.crawl_data.data[0].aboutPage = '';
        oldC.crawl_data.data[0].contactPage = 'Call +44 20 8089 2420';

        new2.crawl_data.data[0].phone = '+44 3338 980725';
        new2.crawl_data.data[0].contactPage = 'Call us at +44 3338 980725.';
        const res2 = compareCrawls(oldC, new2);
        if (res2.has_meaningful_change !== true) return false;
        if (res2.has_pending_confirmation !== true) return false;

        return true;
      }
    },
    {
      id: 22,
      name: 'confirmation & state tracking: confirmChanges reproduces changes, sentChangeIds marks already_reported',
      fn: () => {
        const oldC = clone(baseJson);
        const new1 = clone(baseJson);
        new1.crawl_data.data[0].homeLinks = [
          ...extractUrls(oldC.crawl_data.data[0].homeLinks),
          'https://portal.infynd.com/login'
        ];

        const res1 = compareCrawls(oldC, new1);
        const pendingChange = res1.changes.find(c => c.field === 'subdomain');
        if (!pendingChange || pendingChange.tier !== 'alert_if_confirmed') return false;

        // Confirmation crawl also sees portal.infynd.com
        const confCrawl = clone(new1);
        const resConf = compareCrawls(oldC, confCrawl);

        const confirmed = confirmChanges(res1, resConf);
        if (confirmed.length !== 1) return false;
        if (confirmed[0].change_id !== pendingChange.change_id) return false;
        if (confirmed[0].tier !== 'alert' || confirmed[0].needs_confirmation !== false) return false;

        // State tracking: when change_id is in sentChangeIds, it is marked already_reported and downgraded
        const resReported = compareCrawls(oldC, new1, { sentChangeIds: [pendingChange.change_id] });
        const changeReported = resReported.changes.find(c => c.change_id === pendingChange.change_id);
        if (!changeReported || !changeReported.already_reported) return false;
        if (changeReported.tier !== 'log_only') return false;
        if (resReported.has_meaningful_change || resReported.has_pending_confirmation) return false;

        return true;
      }
    },
    {
      id: 23,
      name: 'stability mode: evaluateStability classifies alert & alert_if_confirmed as false positives, ignores log_only',
      fn: () => {
        const c1 = clone(baseJson);
        const c2 = clone(baseJson);

        // Same domain, minor log-only update
        c2.crawl_data.data[0].title = c1.crawl_data.data[0].title + ' - Updated';
        const stableEval = evaluateStability(c1, c2);
        if (!stableEval.is_stable || stableEval.false_positives.length !== 0) return false;

        // Unstable crawl with phone changed (alert) and new portal subdomain (alert_if_confirmed)
        const c3 = clone(baseJson);
        c3.crawl_data.data[0].phone = '+44 113 496 0000';
        c3.crawl_data.data[0].phoneFormatted = '+44 113 496 0000';
        c3.crawl_data.data[0].aboutPage = '';
        c3.crawl_data.data[0].contactPage = 'Call us at +44 113 496 0000.';
        c3.crawl_data.data[0].homeLinks = [
          ...extractUrls(c1.crawl_data.data[0].homeLinks),
          'https://portal.infynd.com/login'
        ];

        const unstableEval = evaluateStability(c1, c3);
        if (unstableEval.is_stable) return false;
        if (unstableEval.false_positives.length < 2) return false;
        const hasPhone = unstableEval.false_positives.some(c => c.field === 'phone');
        const hasSub = unstableEval.false_positives.some(c => c.field === 'subdomain');

        return hasPhone && hasSub;
      }
    },
    {
      id: 24,
      name: 'error handling: classifyErrorReason correctly categorizes timeout, http_code, dns_error, invalid_json, empty_crawl_data',
      fn: () => {
        const t1 = classifyErrorReason(new Error('Crawler API request timed out after 120000ms'));
        const t2 = classifyErrorReason(new Error('Server responded with 503 Service Unavailable'));
        const t3 = classifyErrorReason(new Error('getaddrinfo ENOTFOUND target.domain'));
        const t4 = classifyErrorReason(new Error('Unexpected token < in JSON at position 0'));
        const t5 = classifyErrorReason(new Error('empty crawl data returned from crawler'));

        return t1 === 'timeout' &&
               t2 === 'http_503' &&
               t3 === 'dns_error' &&
               t4 === 'invalid_json' &&
               t5 === 'empty_crawl_data';
      }
    },
    {
      id: 25,
      name: 'url extraction: extractUrls parses pipe-delimited, bracket-string, array, and nested objects with deduplication',
      fn: () => {
        const uPipe = extractUrls('https://example.com/a|https://example.com/b|https://example.com/a.');
        const uBracket = extractUrls('[https://example.com/a, https://example.com/b]');
        const uObj = extractUrls({
          page1: 'https://example.com/a',
          nested: ['https://example.com/b', 'https://example.com/a;']
        });

        const expected = ['https://example.com/a', 'https://example.com/b'];
        const eq = (a, b) => a.length === b.length && a.every(x => b.includes(x));

        return eq(uPipe, expected) && eq(uBracket, expected) && eq(uObj, expected);
      }
    },
    {
      id: 26,
      name: 'baseline quality: computes baseline_quality and issues for db_baseline_pair',
      fn: () => {
        const oldJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'test', 'fixtures', 'db_baseline_pair', 'old.json'), 'utf8'));
        const newJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'test', 'fixtures', 'db_baseline_pair', 'new.json'), 'utf8'));
        const quality = evaluateBaselineQuality(oldJson, oldJson.data[0], newJson, newJson.data[0]);

        const expectedIssues = [
          'baseline_pages_missing',
          'baseline_catalog_unclassified',
          'baseline_stale_meta',
          'baseline_different_pipeline'
        ];
        const allPresent = expectedIssues.every(iss => quality.issues.includes(iss));
        const res = compareCrawls(oldJson, newJson);

        return quality.level === 'low' &&
               allPresent &&
               res.baseline_quality.level === 'low' &&
               Array.isArray(res.baseline_gaps);
      }
    },
    {
      id: 27,
      name: 'baseline gap rules: caps content changes at log_only, sets recommendation, records gaps',
      fn: () => {
        const oldJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'test', 'fixtures', 'db_baseline_pair', 'old.json'), 'utf8'));
        const newJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'test', 'fixtures', 'db_baseline_pair', 'new.json'), 'utf8'));
        const res = compareCrawls(oldJson, newJson);

        const hasPhoneGap = res.baseline_gaps.some(g => g.field === 'phone' && g.change_type === 'baseline_gap');
        const noAlerts = !res.changes.some(c => c.tier === 'alert' || c.tier === 'alert_if_confirmed');

        return res.has_meaningful_change === false &&
               res.has_pending_confirmation === false &&
               res.recommendation === 'refresh baseline from a live crawl (--accept)' &&
               hasPhoneGap &&
               noAlerts;
      }
    },
    {
      id: 28,
      name: 'derive from raw sources: derives catalog, subdomains, social, and career symmetrically from raw link pool',
      fn: () => {
        const oldJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'test', 'fixtures', 'db_baseline_pair', 'old.json'), 'utf8'));
        const newJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'test', 'fixtures', 'db_baseline_pair', 'new.json'), 'utf8'));
        const oldRec = oldJson.data[0];
        const newRec = newJson.data[0];

        const oldCatalog = extractCatalogAndContentRoutes(oldRec, 'infynd.com');
        const oldSubs = extractSubdomains(oldRec, 'infynd.com');
        const newSubs = extractSubdomains(newRec, 'infynd.com');
        const oldSocial = extractSocialFootprint(oldRec);
        const newSocial = extractSocialFootprint(newRec);

        const res = compareCrawls(oldJson, newJson);

        const oldHasCatalog = oldCatalog.catalogRoutes.size > 0;
        const appInBoth = oldSubs.has('app') && newSubs.has('app');
        const noAppSubChange = !res.changes.some(c => c.field === 'subdomain' && String(c.new_value).includes('app.infynd.com'));
        const twitterInBoth = oldSocial.twitter === 'infynd_data' && newSocial.twitter === 'infynd_data';
        const noTwitterChange = !res.changes.some(c => c.field === 'social_twitter');

        return oldHasCatalog && appInBoth && noAppSubChange && twitterInBoth && noTwitterChange;
      }
    },
    {
      id: 29,
      name: 'phone fixes: prioritizes address/postcode over ipCountry, contextual extraction, excludes registration number',
      fn: () => {
        const newJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'test', 'fixtures', 'db_baseline_pair', 'new.json'), 'utf8'));
        const newRec = newJson.data[0];

        const country = inferCountry({ ipCountry: 'Germany', postal_code: 'RG12 2SJ' });
        if (country !== 'GB') return false;

        const phones = extractAllPhones(newRec);

        return phones.has('+443338980725') &&
               !phones.has('+4912150394') &&
               phones.size === 1;
      }
    },
    {
      id: 30,
      name: 'registration number: compares top-level registration_number with extracted number and marks unchanged',
      fn: () => {
        const oldJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'test', 'fixtures', 'db_baseline_pair', 'old.json'), 'utf8'));
        const newJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'test', 'fixtures', 'db_baseline_pair', 'new.json'), 'utf8'));
        const res = compareCrawls(oldJson, newJson);

        const isUnchanged = res.unchanged_fields.includes('registration_number') ||
                            res.unchanged_fields.includes('legal_registration_number');
        const notInNotFound = !res.not_found_fields.includes('registration_number');
        const noAlert = !res.changes.some(c => c.field === 'legal_registration_number');

        return isUnchanged && notInNotFound && noAlert;
      }
    },
    {
      id: 31,
      name: 'non-circular corroboration: keeps description/title log_only with reason baseline_stale_meta',
      fn: () => {
        const oldJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'test', 'fixtures', 'db_baseline_pair', 'old.json'), 'utf8'));
        const newJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'test', 'fixtures', 'db_baseline_pair', 'new.json'), 'utf8'));
        const res = compareCrawls(oldJson, newJson);

        const descChange = res.changes.find(c => c.field === 'description');
        const titleChange = res.changes.find(c => c.field === 'title');

        return descChange &&
               descChange.tier === 'log_only' &&
               descChange.reason === 'baseline_stale_meta' &&
               titleChange &&
               titleChange.tier === 'log_only' &&
               titleChange.reason === 'baseline_stale_meta';
      }
    },
    {
      id: 32,
      name: 'coverage guard: downgrades catalog and subdomains to log_only with reason coverage_difference',
      fn: () => {
        const oldJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'test', 'fixtures', 'db_baseline_pair', 'old.json'), 'utf8'));
        const newJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'test', 'fixtures', 'db_baseline_pair', 'new.json'), 'utf8'));
        const res = compareCrawls(oldJson, newJson);

        const prodSub = res.changes.find(c => c.field === 'subdomain' && c.new_value === 'product.infynd.com');
        const sentSub = res.changes.find(c => c.field === 'subdomain' && c.new_value === 'sentinel.infynd.com');
        const catExp = res.changes.find(c => c.field === 'catalog' && c.change_type === 'catalog_expanded');

        return res.coverage && (res.coverage.ratio < 0.5 || res.coverage.ratio > 2.0) &&
               prodSub && prodSub.tier === 'log_only' && prodSub.reason === 'coverage_difference' &&
               sentSub && sentSub.tier === 'log_only' && sentSub.reason === 'coverage_difference' &&
               catExp && catExp.tier === 'log_only' && catExp.reason === 'coverage_difference';
      }
    },
    {
      id: 33,
      name: 'otherLinks shifts: reports otherLinks shifts as log_only and guards career ATS migration without prior baseline',
      fn: () => {
        // Part A: db_baseline_pair contactUs moved to sentinel
        const oldJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'test', 'fixtures', 'db_baseline_pair', 'old.json'), 'utf8'));
        const newJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'test', 'fixtures', 'db_baseline_pair', 'new.json'), 'utf8'));
        const resA = compareCrawls(oldJson, newJson);
        const contactChange = resA.changes.find(c => c.field === 'otherLinks.contactUs');
        const passA = contactChange && contactChange.tier === 'log_only' && contactChange.change_type === 'modified';

        // Part B: no career link existed in old -> ATS link does not alert
        const oldB = {
          data: [{
            normalizedDomain: 'example.com',
            homeLinks: '[]'
          }]
        };
        const newB = {
          data: [{
            normalizedDomain: 'example.com',
            homeLinks: '[]',
            otherLinks: { career: 'https://jobs.lever.co/example' }
          }]
        };
        const resB = compareCrawls(oldB, newB);
        const careerAlert = resB.changes.some(c => c.field === 'career_portal' && c.tier === 'alert_if_confirmed');

        return passA && !careerAlert;
      }
    }
  ];

  let passedCount = 0;
  for (const test of tests) {
    try {
      const pass = test.fn();
      if (pass) {
        console.log(`[PASS] Case ${test.id}: ${test.name}`);
        passedCount++;
      } else {
        console.error(`[FAIL] Case ${test.id}: ${test.name}`);
      }
    } catch (err) {
      console.error(`[ERROR] Case ${test.id}: ${test.name} - ${err.message}`);
    }
  }

  console.log(`\nSelfTest Summary: ${passedCount} / ${tests.length} passed.`);
  return passedCount === tests.length;
}

// ============================================================================
// CLI RUNNER
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--selftest')) {
    const success = runSelfTest();
    process.exit(success ? 0 : 1);
  }

  const saveBaseline = args.includes('--save-baseline');

  // Mode: --accept <domain> (Item 6)
  const acceptIdx = args.indexOf('--accept');
  if (acceptIdx !== -1 && args[acceptIdx + 1]) {
    const targetDomain = args[acceptIdx + 1].trim();
    const newPath = path.resolve(process.cwd(), 'data', 'new', `${targetDomain}.json`);
    const oldPath = path.resolve(process.cwd(), 'data', 'old', `${targetDomain}.json`);

    if (!fs.existsSync(newPath)) {
      console.error(`[Comparator Error] New snapshot data/new/${targetDomain}.json does not exist to accept.`);
      process.exit(1);
    }

    const newData = JSON.parse(fs.readFileSync(newPath, 'utf8'));
    atomicWriteJson(oldPath, newData);
    console.log(`[Comparator] Successfully promoted data/new/${targetDomain}.json to baseline data/old/${targetDomain}.json`);
    return;
  }

  // Mode: --confirm [--confirm-delay <sec>] [--domain <domain>] (Item 6)
  if (args.includes('--confirm')) {
    if (!crawlerService) crawlerService = require('./crawler_service');
    const delayIdx = args.indexOf('--confirm-delay');
    const delaySec = delayIdx !== -1 && args[delayIdx + 1] ? parseInt(args[delayIdx + 1], 10) : 300;

    const domainIdx = args.indexOf('--domain');
    const specificDomain = domainIdx !== -1 && args[domainIdx + 1] ? args[domainIdx + 1].trim() : null;

    const resultsPath = path.resolve(process.cwd(), 'results', 'comparison_results.json');
    if (!fs.existsSync(resultsPath)) {
      console.log('[Confirm] No results/comparison_results.json found.');
      return;
    }

    let results = [];
    try {
      results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
    } catch {
      results = [];
    }

    const pendingEntries = results.filter(r =>
      r.has_pending_confirmation && (!specificDomain || r.domain === specificDomain)
    );

    if (pendingEntries.length === 0) {
      console.log('[Confirm] No domains pending confirmation.');
      return;
    }

    console.log(`[Confirm] Found ${pendingEntries.length} domain(s) pending confirmation.`);
    if (delaySec > 0) {
      console.log(`[Confirm] Waiting confirm delay: ${delaySec}s...`);
      await new Promise(r => setTimeout(r, delaySec * 1000));
    }

    const sentState = loadSentChangeIds();
    for (const entry of pendingEntries) {
      const d = entry.domain;
      console.log(`[Confirm] Re-crawling domain: ${d}...`);
      const oldPath = path.resolve(process.cwd(), 'data', 'old', `${d}.json`);
      if (!fs.existsSync(oldPath)) {
        console.warn(`[Confirm] Baseline not found for ${d}, skipping.`);
        continue;
      }

      try {
        const confCrawl = await crawlerService.crawlDomain(d);
        const oldJson = readOldJsonFile(oldPath);
        const confResult = compareCrawls(oldJson, confCrawl, { sentChangeIds: sentState });
        const confirmedChanges = confirmChanges(entry, confResult);

        if (confirmedChanges.length > 0) {
          console.log(`[Confirm] Domain ${d}: confirmed ${confirmedChanges.length} changes!`);
          for (const conf of confirmedChanges) {
            const idx = entry.changes.findIndex(c => c.change_id === conf.change_id);
            if (idx >= 0) {
              entry.changes[idx] = conf;
            }
          }
          entry.has_meaningful_change = true;
          entry.has_pending_confirmation = entry.changes.some(c => c.tier === 'alert_if_confirmed');
          entry.confirmed_at = new Date().toISOString();
          entry.summary = `Confirmed business changes: ${confirmedChanges.map(c => c.field).join(', ')}.`;
          markChangeIdsReported(confirmedChanges, d);
        } else {
          console.log(`[Confirm] Domain ${d}: 0 pending changes reproduced (noise dismissed).`);
          entry.has_pending_confirmation = false;
        }

        recordResult(entry);
      } catch (err) {
        console.error(`[Confirm Error] Domain ${d}: ${err.message}`);
      }
    }

    console.log('[Confirm] Completed confirmation flow.');
    return;
  }

  // Mode: --stability <domains.txt> [--gap <sec>] (Item 7)
  const stabilityIdx = args.indexOf('--stability');
  if (stabilityIdx !== -1 && args[stabilityIdx + 1]) {
    const listFile = path.resolve(process.cwd(), args[stabilityIdx + 1].trim());
    if (!fs.existsSync(listFile)) {
      console.error(`[Stability Error] Domain list file not found: ${listFile}`);
      process.exit(1);
    }

    if (!crawlerService) crawlerService = require('./crawler_service');

    const gapIdx = args.indexOf('--gap');
    const gapSec = gapIdx !== -1 && args[gapIdx + 1] ? parseInt(args[gapIdx + 1], 10) : 120;

    const domains = fs.readFileSync(listFile, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));

    console.log(`\n======================================================`);
    console.log(`STABILITY TEST RUNNER: ${domains.length} domain(s), gap: ${gapSec}s`);
    console.log(`======================================================\n`);

    const report = {
      generated_at: new Date().toISOString(),
      gap_seconds: gapSec,
      total_domains: domains.length,
      domains_tested: domains,
      zero_fp_domains: [],
      zero_fp_count: 0,
      false_positive_count: 0,
      false_positives_by_type: {},
      details: []
    };

    for (let i = 0; i < domains.length; i++) {
      const d = domains[i];
      console.log(`[Stability ${i + 1}/${domains.length}] Starting domain: ${d}`);

      // Crawl 1
      let crawl1 = null;
      try {
        console.log(`  -> Fetching Crawl 1 for ${d}...`);
        crawl1 = await fetchCrawlWithRetry(d);
      } catch (err) {
        const reason = classifyErrorReason(err);
        console.error(`  [!] Crawl 1 failed for ${d} (${reason}): ${err.message}`);
        report.details.push({
          domain: d,
          status: 'error',
          error_stage: 'crawl_1',
          reason,
          false_positives: []
        });
        continue;
      }

      // Wait gap
      console.log(`  -> Waiting ${gapSec}s gap before Crawl 2...`);
      await new Promise(r => setTimeout(r, gapSec * 1000));

      // Crawl 2
      let crawl2 = null;
      try {
        console.log(`  -> Fetching Crawl 2 for ${d}...`);
        crawl2 = await fetchCrawlWithRetry(d);
      } catch (err) {
        const reason = classifyErrorReason(err);
        console.error(`  [!] Crawl 2 failed for ${d} (${reason}): ${err.message}`);
        report.details.push({
          domain: d,
          status: 'error',
          error_stage: 'crawl_2',
          reason,
          false_positives: []
        });
        continue;
      }

      // Evaluate Stability
      const evalResult = evaluateStability(crawl1, crawl2);
      const fps = evalResult.false_positives;

      if (fps.length === 0) {
        console.log(`  -> [PASS] Domain ${d} is STABLE (0 false positives, ${evalResult.log_only.length} noise logged)`);
        report.zero_fp_domains.push(d);
      } else {
        console.warn(`  -> [FAIL] Domain ${d} had ${fps.length} FALSE POSITIVE(S):`);
        for (const fp of fps) {
          console.warn(`     * [${fp.tier}] ${fp.field} (${fp.change_type}): ${fp.description}`);
          const key = `${fp.field}:${fp.change_type}`;
          if (!report.false_positives_by_type[key]) report.false_positives_by_type[key] = [];
          report.false_positives_by_type[key].push({
            domain: d,
            field: fp.field,
            change_type: fp.change_type,
            tier: fp.tier,
            old_value: fp.old_value,
            new_value: fp.new_value,
            description: fp.description
          });
        }
      }

      report.false_positive_count += fps.length;
      report.details.push({
        domain: d,
        status: evalResult.status,
        is_stable: evalResult.is_stable,
        false_positives: fps,
        log_only_count: evalResult.log_only.length
      });
    }

    report.zero_fp_count = report.zero_fp_domains.length;

    // Write stability report JSON
    const reportPath = path.resolve(process.cwd(), 'results', 'stability_report.json');
    atomicWriteJson(reportPath, report);

    // Print formatted summary table
    console.log(`\n======================================================`);
    console.log(`STABILITY REPORT SUMMARY`);
    console.log(`======================================================`);
    console.log(`Total domains tested:        ${report.total_domains}`);
    console.log(`Zero false positive domains: ${report.zero_fp_count} (${report.total_domains > 0 ? Math.round(report.zero_fp_count / report.total_domains * 100) : 0}%)`);
    console.log(`Total false positives:       ${report.false_positive_count}`);
    console.log(`\nDomain Breakdown:`);
    console.log(`--------------------------------------------------------------------------------`);
    console.log(`| Domain                         | Status | FP Alerts | Noise Logged | Verdict |`);
    console.log(`--------------------------------------------------------------------------------`);
    for (const det of report.details) {
      const dCol = det.domain.padEnd(30, ' ').slice(0, 30);
      const sCol = (det.status || 'ok').padEnd(6, ' ').slice(0, 6);
      const fpCol = String(det.false_positives?.length || 0).padEnd(9, ' ');
      const nCol = String(det.log_only_count || 0).padEnd(12, ' ');
      const vCol = det.is_stable ? 'STABLE' : 'UNSTABLE';
      console.log(`| ${dCol} | ${sCol} | ${fpCol} | ${nCol} | ${vCol}  |`);
    }
    console.log(`--------------------------------------------------------------------------------`);
    console.log(`Report written to: ${reportPath}\n`);
    return;
  }

  // Mode: --domain <domain>
  const domainIdx = args.indexOf('--domain');
  if (domainIdx !== -1 && args[domainIdx + 1]) {
    const targetDomain = args[domainIdx + 1].trim();
    if (!crawlerService) crawlerService = require('./crawler_service');

    console.log(`[Comparator] Processing domain: ${targetDomain}`);
    const oldPath = path.resolve(process.cwd(), 'data', 'old', `${targetDomain}.json`);
    const newPath = path.resolve(process.cwd(), 'data', 'new', `${targetDomain}.json`);

    try {
      const liveCrawl = await fetchCrawlWithRetry(targetDomain);
      atomicWriteJson(newPath, liveCrawl);

      if (!fs.existsSync(oldPath)) {
        console.log(`[Comparator] Baseline not found. Creating baseline at ${oldPath}`);
        atomicWriteJson(oldPath, liveCrawl);
        const entry = {
          domain: targetDomain,
          compared_at: new Date().toISOString(),
          status: 'baseline_created',
          has_meaningful_change: false,
          has_pending_confirmation: false,
          summary: `Baseline crawl snapshot created for ${targetDomain}.`,
          changes: [],
          noise_detected: [],
          unchanged_fields: [],
          not_found_fields: []
        };
        recordResult(entry);
        console.log(JSON.stringify(entry, null, 2));
        return;
      }

      const sentState = loadSentChangeIds();
      const oldJson = readOldJsonFile(oldPath);
      const result = compareCrawls(oldJson, liveCrawl, { sentChangeIds: sentState });

      if (saveBaseline) {
        console.log(`[Comparator] Overwriting baseline snapshot for ${targetDomain}`);
        atomicWriteJson(oldPath, liveCrawl);
      }

      if (result.changes?.length > 0) {
        markChangeIdsReported(result.changes, targetDomain);
      }

      recordResult(result);
      console.log(JSON.stringify(result, null, 2));
    } catch (err) {
      const reason = classifyErrorReason(err);
      console.error(`[Comparator Error] Failed to process ${targetDomain} (${reason}): ${err.message}`);
      const errEntry = {
        domain: targetDomain,
        compared_at: new Date().toISOString(),
        status: 'error',
        reason,
        has_meaningful_change: false,
        has_pending_confirmation: false,
        summary: `Error crawling or comparing ${targetDomain}: ${err.message}`,
        changes: [],
        noise_detected: [],
        unchanged_fields: [],
        not_found_fields: []
      };
      recordResult(errEntry);
      process.exit(1);
    }
    return;
  }

  // Mode: --batch <domains.txt> [--concurrency <num>] [--save-baseline] (Item 8)
  const batchIdx = args.indexOf('--batch');
  if (batchIdx !== -1 && args[batchIdx + 1]) {
    const batchFile = path.resolve(process.cwd(), args[batchIdx + 1].trim());
    if (!fs.existsSync(batchFile)) {
      console.error(`[Comparator Error] Batch file not found: ${batchFile}`);
      process.exit(1);
    }

    if (!crawlerService) crawlerService = require('./crawler_service');

    const concIdx = args.indexOf('--concurrency');
    const requestedConc = concIdx !== -1 && args[concIdx + 1] ? parseInt(args[concIdx + 1], 10) : 3;
    const concurrency = Math.max(1, isNaN(requestedConc) ? 3 : requestedConc);

    const lines = fs.readFileSync(batchFile, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'));

    console.log(`[Comparator Batch] Processing ${lines.length} domains with concurrency ${concurrency}...`);

    const reasonCounts = {};
    function recordOutcome(key) {
      reasonCounts[key] = (reasonCounts[key] || 0) + 1;
    }

    const sentState = loadSentChangeIds();
    let index = 0;
    async function worker() {
      while (index < lines.length) {
        const domain = lines[index++];
        console.log(`[Batch Worker] Starting: ${domain}`);
        const oldPath = path.resolve(process.cwd(), 'data', 'old', `${domain}.json`);
        const newPath = path.resolve(process.cwd(), 'data', 'new', `${domain}.json`);

        let liveCrawl = null;
        try {
          liveCrawl = await fetchCrawlWithRetry(domain);
        } catch (err) {
          const reason = classifyErrorReason(err);
          console.error(`[Batch Error] Domain ${domain} failed (${reason}): ${err.message}`);
          recordOutcome(reason);
          const errEntry = {
            domain,
            compared_at: new Date().toISOString(),
            status: 'error',
            reason,
            has_meaningful_change: false,
            has_pending_confirmation: false,
            summary: `Crawl error on ${domain}: ${err.message}`,
            changes: [],
            noise_detected: [],
            unchanged_fields: [],
            not_found_fields: []
          };
          recordResult(errEntry);
          continue;
        }

        try {
          atomicWriteJson(newPath, liveCrawl);
          if (!fs.existsSync(oldPath)) {
            console.log(`[Batch] Created baseline for ${domain}`);
            atomicWriteJson(oldPath, liveCrawl);
            recordOutcome('baseline_created');
            recordResult({
              domain,
              compared_at: new Date().toISOString(),
              status: 'baseline_created',
              has_meaningful_change: false,
              has_pending_confirmation: false,
              summary: `Baseline snapshot established for ${domain}.`,
              changes: [],
              noise_detected: [],
              unchanged_fields: [],
              not_found_fields: []
            });
          } else {
            const oldJson = readOldJsonFile(oldPath);
            const res = compareCrawls(oldJson, liveCrawl, { sentChangeIds: sentState });
            if (saveBaseline) {
              atomicWriteJson(oldPath, liveCrawl);
            }
            if (res.changes?.length > 0) {
              markChangeIdsReported(res.changes, domain);
            }
            recordResult(res);
            const outcomeKey = res.reason || (res.status === 'ok' ? (res.has_meaningful_change ? 'ok_meaningful_change' : 'ok_no_change') : res.status);
            recordOutcome(outcomeKey);
            console.log(`[Batch Done] ${domain}: status=${res.status}, meaningful_change=${res.has_meaningful_change}`);
          }
        } catch (procErr) {
          const reason = classifyErrorReason(procErr);
          console.error(`[Batch Process Error] ${domain}: ${procErr.message}`);
          recordOutcome(reason);
          recordResult({
            domain,
            compared_at: new Date().toISOString(),
            status: 'error',
            reason,
            has_meaningful_change: false,
            has_pending_confirmation: false,
            summary: `Comparison processing error on ${domain}: ${procErr.message}`,
            changes: [],
            noise_detected: [],
            unchanged_fields: [],
            not_found_fields: []
          });
        }
      }
    }

    const actualWorkers = Math.min(concurrency, lines.length);
    const workers = Array.from({ length: actualWorkers }, () => worker());
    await Promise.all(workers);

    console.log(`\n======================================================`);
    console.log(`BATCH EXECUTION SUMMARY`);
    console.log(`======================================================`);
    console.log(`Total domains processed: ${lines.length}`);
    console.log(`Summary counts by outcome/reason:`);
    for (const [r, count] of Object.entries(reasonCounts)) {
      console.log(`  - ${r.padEnd(25, ' ')} : ${count}`);
    }
    console.log(`======================================================\n`);
    return;
  }

  // Mode: node comparator.js <old.json> <new.json>
  if (args.length >= 2 && !args[0].startsWith('--')) {
    const oldPath = path.resolve(process.cwd(), args[0]);
    const newPath = path.resolve(process.cwd(), args[1]);

    if (!fs.existsSync(oldPath) || !fs.existsSync(newPath)) {
      console.error('[Comparator Error] One or both input files do not exist.');
      process.exit(1);
    }

    const oldJson = readOldJsonFile(oldPath);
    const newJson = JSON.parse(fs.readFileSync(newPath, 'utf8'));
    const result = compareCrawls(oldJson, newJson);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`
Usage:
  node comparator.js --selftest
  node comparator.js <old.json> <new.json>
  node comparator.js --domain <domain> [--save-baseline]
  node comparator.js --batch <domains.txt> [--concurrency <num>] [--save-baseline]
  node comparator.js --confirm [--confirm-delay <sec>] [--domain <domain>]
  node comparator.js --accept <domain>
  node comparator.js --stability <domains.txt> [--gap <sec>]
  `);
}

module.exports = {
  compareCrawls,
  confirmChanges,
  evaluateStability,
  classifyErrorReason,
  extractUrls,
  evaluateBaselineQuality,
  getRawLinkPool,
  extractCatalogAndContentRoutes,
  extractSubdomains,
  extractSocialFootprint,
  extractCareerLink,
  extractAllPhones,
  countPhoneSources,
  inferCountry,
  loadSentChangeIds,
  markChangeIdsReported,
  CONFIG
};

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
