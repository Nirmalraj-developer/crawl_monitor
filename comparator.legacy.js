/**
 * Comparator Engine (comparator.js)
 * ---------------------------------
 * Responsibility: Performs deep, rule-based change detection between
 * an existing stored crawl JSON and a fresh crawl JSON across ALL data fields:
 *   1. Website Status & Availability (404, DNS error, parked)
 *   2. Brand Name & Rebranding (with legal suffix normalizer)
 *   3. Corporate Structure & Legal Entity (Trading name / Registered Ltd)
 *   4. Description & Value Proposition (Jaccard token similarity & drift)
 *   5. Industry & Market Positioning (Dynamic topic clustering)
 *   6. Subdomains & Platform Infrastructure (SaaS apps, client portals)
 *   7. Products, Solutions & Services Catalog (Set difference on URLs)
 *   8. Contact Phone & Fax (Normalized international dial codes)
 *   9. Email Channels (Generic vs. departmental emails)
 *  10. Physical Office Address (Extracted from contact/about pages)
 *  11. Social Media Footprint (LinkedIn, X/Twitter, Facebook, Instagram)
 *  12. Careers & Talent Acquisition (Recruitment portal shifts)
 */

const crypto = require('crypto');

// Legal Suffixes & Entity Modifiers (Stripped to prevent false rebrand alarms)
const LEGAL_SUFFIXES = [
  'private limited', 'pvt ltd', 'pvt. ltd.', 'pvt', 'limited', 'ltd', 'ltd.',
  'incorporated', 'inc', 'inc.', 'corporation', 'corp', 'corp.',
  'limited liability company', 'llc', 'l.l.c.', 'llp', 'l.l.p.',
  'gmbh', 'plc', 's.a.', 'sa', 'b.v.', 'bv', 'co.', 'co', 'company'
];

const CORPORATE_MODIFIERS = [
  'group', 'holdings', 'holding', 'ventures', 'technologies', 'technology',
  'solutions', 'services', 'systems', 'consulting', 'international', 'global',
  'enterprises', 'digital'
];

// Cosmetic noise patterns that do NOT indicate business changes
const NOISE_PATTERNS = [
  /©\s*\d{4}(?:\s*-\s*\d{4})?/gi,
  /all rights reserved/gi,
  /cookie policy|privacy policy|terms & conditions/gi,
  /\b\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}\b/gi,
];

/**
 * Strips dynamic dates and copyright notices from text.
 */
function stripCosmeticNoise(text) {
  if (!text || typeof text !== 'string') return '';
  let cleaned = text;
  for (const pattern of NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, ' ');
  }
  return cleaned.replace(/\s+/g, ' ').trim();
}

/**
 * Normalizes a brand name to its core stem.
 * Prevents false positives like "InFynd" -> "InFynd Pvt Ltd" or "InFynd Group".
 */
function normalizeBrandStem(name) {
  if (!name || typeof name !== 'string') return '';
  let clean = name.toLowerCase().trim();
  clean = clean.replace(/^[,\s-]+|[,\s-]+$/g, '');
  clean = clean.replace(/[,.]/g, ' ');

  // 1. Strip legal suffixes from end
  for (const suffix of LEGAL_SUFFIXES) {
    const regex = new RegExp(`\\b${suffix}\\b$`, 'i');
    clean = clean.replace(regex, '').trim();
  }

  // 2. Strip corporate modifiers from end
  for (const mod of CORPORATE_MODIFIERS) {
    const regex = new RegExp(`\\b${mod}\\b$`, 'i');
    clean = clean.replace(regex, '').trim();
  }

  return clean.replace(/\s+/g, ' ').trim();
}

/**
 * Normalizes phone numbers (handles international dial codes, trunk zeros, formatting).
 */
function normalizePhone(phone) {
  if (!phone) return '';
  let digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('44')) digits = digits.slice(2);
  if (digits.startsWith('1') && digits.length === 11) digits = digits.slice(1);
  if (digits.startsWith('91') && digits.length > 10) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

/**
 * Token Jaccard similarity (0.0 to 1.0)
 */
function calculateSimilarity(str1, str2) {
  if (!str1 || !str2) return 0;
  const set1 = new Set(stripCosmeticNoise(str1).toLowerCase().split(/\W+/).filter(w => w.length > 2));
  const set2 = new Set(stripCosmeticNoise(str2).toLowerCase().split(/\W+/).filter(w => w.length > 2));

  if (set1.size === 0 && set2.size === 0) return 1.0;
  if (set1.size === 0 || set2.size === 0) return 0.0;

  let intersection = 0;
  for (const token of set1) {
    if (set2.has(token)) intersection++;
  }
  const union = set1.size + set2.size - intersection;
  return union === 0 ? 1.0 : Number((intersection / union).toFixed(3));
}

/**
 * Normalizes a URL for comparison (removes www, trailing slash, queries).
 */
function cleanUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const urlObj = new URL(rawUrl.startsWith('http') ? rawUrl : `https://${rawUrl}`);
    return (urlObj.hostname.replace(/^www\./, '') + urlObj.pathname).replace(/\/+$/, '').toLowerCase();
  } catch {
    return rawUrl.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
  }
}

/**
 * Parses link strings or arrays (handles stringified array representations like "[url1, url2]").
 */
function parseLinks(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(l => String(l).trim()).filter(Boolean);
  if (typeof raw === 'string') {
    const cleaned = raw.replace(/^\[|\]$/g, '');
    return cleaned.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }
  return [];
}

/**
 * Extracts subdomains and login portals from link collections.
 */
function extractSubdomainsAndPortals(links, rootDomain) {
  const subdomains = new Set();
  const portals = new Set();
  const cleanRoot = (rootDomain || '').replace(/^www\./, '').toLowerCase();

  for (const link of links) {
    try {
      const u = new URL(link.startsWith('http') ? link : `https://${link}`);
      const host = u.hostname.replace(/^www\./, '').toLowerCase();

      // Check for custom subdomains under root domain
      if (cleanRoot && host.endsWith(cleanRoot) && host !== cleanRoot) {
        subdomains.add(host);
      } else if (!cleanRoot && host.split('.').length > 2) {
        subdomains.add(host);
      }

      // Check for SaaS application/login portals
      if (u.pathname.includes('/login') || u.pathname.includes('/auth') || u.pathname.includes('/app') || host.startsWith('app.')) {
        portals.add(`${host}${u.pathname}`.replace(/\/+$/, ''));
      }
    } catch {
      // Ignore unparseable URLs
    }
  }

  return {
    subdomains: Array.from(subdomains).sort(),
    portals: Array.from(portals).sort(),
  };
}

/**
 * Extracts a normalized, comprehensive record from any crawler output.
 */
function extractRecord(raw) {
  if (!raw) return {};
  let item = raw;

  // Unwrap wrapper layers if present
  if (item.crawl_data) item = item.crawl_data;
  if (Array.isArray(item.data) && item.data.length > 0) item = item.data[0];
  if (Array.isArray(item) && item.length > 0) item = item[0];

  const domain = item.normalizedDomain || item.domain_name || item.domain || '';

  // 1. Company Name candidates
  const companyNameCandidates = [
    item.nameFromTitle,
    item.clearbitName,
    item.companyName,
    item.company_name,
    item.name,
  ].filter(Boolean);
  const bestName = companyNameCandidates.length > 0 ? String(companyNameCandidates[0]).trim() : '';

  // 2. Legal / Registered Entity Name
  let legalName = item.nameFromCopyright || '';
  if (!legalName && item.contactPage) {
    const regMatch = item.contactPage.match(/([A-Za-z0-9\s]+(?:LTD|LIMITED|INC|LLC|CORP|GMBH|PLC))\b/i);
    if (regMatch) legalName = regMatch[1].trim();
  }

  // 3. Emails (pipe, comma, semicolon separated)
  const rawEmails = String(item.email || item.genericEmail || '')
    .split(/[|,;]/)
    .map(e => e.trim().toLowerCase())
    .filter(e => e && e.includes('@'));

  // 4. Phones
  let phone = item.phone || item.phoneFormatted || '';
  if (!phone && item.contactPage) {
    const phoneMatch = item.contactPage.match(/\+?\d{1,4}[ -]?\(?\d{2,4}\)?[ -]?\d{3,4}[ -]?\d{3,4}/);
    if (phoneMatch) phone = phoneMatch[0];
  }

  // 5. Office Address
  let address = item.address || '';
  if (!address && item.contactPage) {
    const addrMatch = item.contactPage.match(/Address:?\s*([^\n\r.]+)/i) ||
      item.contactPage.match(/(?:Lily Hill House|Suite|Building|Floor|Street|Road|Avenue)[^,\n\r]+,\s*[^,\n\r]+(?:,\s*[A-Z]{1,2}\d{1,2}\s*\d[A-Z]{2}|\b\d{5}\b)?/i);
    if (addrMatch) address = addrMatch[0].replace(/^Address:?\s*/i, '').trim();
  }

  // 6. Products, Services, E-commerce offerings
  const productLinks = parseLinks(item.productLinks).map(cleanUrl);
  const serviceLinks = parseLinks(item.serviceLinks).map(cleanUrl);
  const ecommerceLinks = parseLinks(item.ecommerceLinks).map(cleanUrl);
  const allProducts = Array.from(new Set([...productLinks, ...serviceLinks, ...ecommerceLinks])).filter(Boolean);

  // 7. Subdomains and SaaS Portals
  const allDiscoveredLinks = [
    ...parseLinks(item.homeLinks),
    ...parseLinks(item.contactLinksAll),
    ...parseLinks(item.productLinks),
    ...Object.values(item.otherLinks || {}).filter(Boolean),
  ];
  const { subdomains, portals } = extractSubdomainsAndPortals(allDiscoveredLinks, domain);

  // 8. Social Channels
  const social = {};
  if (item.socialLinks && typeof item.socialLinks === 'object') {
    for (const [k, v] of Object.entries(item.socialLinks)) {
      if (v && typeof v === 'string' && v.trim().length > 0 && !['privacy', 'terms'].includes(k)) {
        social[k] = cleanUrl(v);
      }
    }
  }

  // 9. Career / Hiring Portal
  const careerLink = item.otherLinks?.career ? cleanUrl(item.otherLinks.career) : '';

  // 10. Availability & Health
  const homeContent = item.homeContent || item.content || '';
  const isDown = String(item.responseCode) === '404' ||
    homeContent.includes('404 Not Found') ||
    homeContent.includes('NoSuchKey') ||
    homeContent.toLowerCase().includes('domain for sale') ||
    homeContent.toLowerCase().includes('this domain is parked');

  return {
    domain,
    company_name: bestName,
    legal_name: legalName,
    title: item.title || '',
    description: item.description || '',
    home_content: homeContent,
    clean_home_content: stripCosmeticNoise(homeContent),
    emails: Array.from(new Set(rawEmails)).sort(),
    phone: phone ? String(phone).trim() : '',
    address: address ? String(address).trim() : '',
    products: allProducts.sort(),
    subdomains,
    portals,
    social,
    career_link: careerLink,
    is_down_or_parked: isDown,
    response_code: item.responseCode || '200',
  };
}

/**
 * Universal dynamic topic extraction (identifies prominent industry themes from text)
 */
function extractTopicKeywords(text) {
  if (!text) return [];
  const words = text.toLowerCase().match(/\b[a-z]{3,}\b/g) || [];
  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'that', 'this', 'from', 'our', 'all', 'more',
    'your', 'you', 'are', 'was', 'were', 'been', 'will', 'have', 'has', 'had',
    'about', 'into', 'across', 'their', 'one', 'two', 'three', 'out', 'what'
  ]);
  const freq = {};
  for (const w of words) {
    if (stopWords.has(w)) continue;
    freq[w] = (freq[w] || 0) + 1;
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([w]) => w);
}

/**
 * Compares an existing stored crawl against a new crawl across all dimensions.
 */
function compareCrawls(previousCrawl, newCrawl) {
  const oldRec = extractRecord(previousCrawl);
  const newRec = extractRecord(newCrawl);

  const changes = [];
  const unchangedFields = [];
  const noiseDetected = [];

  // ============================================================
  // CHECK 1: Website Health & DNS Availability
  // ============================================================
  if (newRec.is_down_or_parked) {
    return {
      domain: newRec.domain || oldRec.domain,
      has_meaningful_change: true,
      status: 'SITE_DOWN_OR_PARKED',
      summary: 'Target website is offline, returned 404, or is showing a parked domain page.',
      changes: [
        {
          field: 'website_status',
          old_value: 'active',
          new_value: 'down_or_parked',
          change_type: 'critical_status_change',
          confidence: 1.0,
          evidence: `Crawl response indicated website unavailable (HTTP ${newRec.response_code}).`
        }
      ],
      unchanged_fields: [],
      noise_detected: [],
      requires_human_review: true,
    };
  }

  // ============================================================
  // CHECK 2: Brand Name & Rebranding
  // ============================================================
  if (oldRec.company_name && newRec.company_name) {
    const oldStem = normalizeBrandStem(oldRec.company_name);
    const newStem = normalizeBrandStem(newRec.company_name);

    if (oldStem && newStem && oldStem !== newStem) {
      changes.push({
        field: 'company_name',
        old_value: oldRec.company_name,
        new_value: newRec.company_name,
        change_type: 'rebrand',
        confidence: 0.95,
        evidence: `Rebranding detected: Core brand stem changed from "${oldRec.company_name}" to "${newRec.company_name}".`
      });
    } else {
      if (oldRec.company_name.toLowerCase().trim() !== newRec.company_name.toLowerCase().trim()) {
        noiseDetected.push(
          `Entity suffix/legal styling variant ('${oldRec.company_name}' vs '${newRec.company_name}') - preserved as identical core brand.`
        );
      }
      unchangedFields.push('company_name');
    }
  }

  // ============================================================
  // CHECK 3: Registered Legal Entity Name
  // ============================================================
  if (oldRec.legal_name && newRec.legal_name && oldRec.legal_name.toLowerCase() !== newRec.legal_name.toLowerCase()) {
    changes.push({
      field: 'legal_entity_name',
      old_value: oldRec.legal_name,
      new_value: newRec.legal_name,
      change_type: 'modified',
      confidence: 0.92,
      evidence: `Corporate registered entity changed from "${oldRec.legal_name}" to "${newRec.legal_name}".`
    });
  }

  // ============================================================
  // CHECK 4: Description & Core Value Proposition
  // ============================================================
  if (oldRec.description && newRec.description) {
    const descSim = calculateSimilarity(oldRec.description, newRec.description);
    if (descSim < 0.60) {
      changes.push({
        field: 'description',
        old_value: oldRec.description,
        new_value: newRec.description,
        change_type: 'modified',
        confidence: 0.92,
        evidence: `Meta description updated (semantic similarity: ${(descSim * 100).toFixed(0)}%): "${newRec.description}".`
      });
    } else {
      if (descSim < 1.0) {
        noiseDetected.push(`Minor copywriting adjustment in description (${(descSim * 100).toFixed(0)}% match) - filtered out.`);
      }
      unchangedFields.push('description');
    }
  }

  // ============================================================
  // CHECK 5: Market Positioning & Industry Shift
  // ============================================================
  const oldTopics = extractTopicKeywords(oldRec.clean_home_content + ' ' + oldRec.description);
  const newTopics = extractTopicKeywords(newRec.clean_home_content + ' ' + newRec.description);

  if (oldTopics.length > 0 && newTopics.length > 0) {
    const oldTopSet = new Set(oldTopics.slice(0, 5));
    const overlap = newTopics.slice(0, 5).filter(t => oldTopSet.has(t)).length;
    // If top 5 thematic keywords have almost zero overlap (< 20%)
    if (overlap <= 1 && oldTopics.length >= 3) {
      changes.push({
        field: 'market_positioning',
        old_value: oldTopics.slice(0, 4).join(', '),
        new_value: newTopics.slice(0, 4).join(', '),
        change_type: 'thematic_pivot',
        confidence: 0.90,
        evidence: `Primary homepage themes shifted from [${oldTopics.slice(0, 3).join(', ')}] to [${newTopics.slice(0, 3).join(', ')}].`
      });
    } else {
      unchangedFields.push('market_positioning');
    }
  }

  // ============================================================
  // CHECK 6: Subdomains & Infrastructure Platforms
  // ============================================================
  const oldSubSet = new Set(oldRec.subdomains || []);
  const addedSubdomains = (newRec.subdomains || []).filter(s => !oldSubSet.has(s));
  const removedSubdomains = (oldRec.subdomains || []).filter(s => !(newRec.subdomains || []).includes(s));

  if (addedSubdomains.length > 0 || removedSubdomains.length > 0) {
    changes.push({
      field: 'subdomains_infrastructure',
      old_value: oldRec.subdomains,
      new_value: newRec.subdomains,
      change_type: addedSubdomains.length > 0 ? 'infrastructure_expanded' : 'infrastructure_reduced',
      confidence: 0.95,
      evidence: addedSubdomains.length > 0
        ? `New dedicated subdomains deployed: ${addedSubdomains.join(', ')}.`
        : `Decommissioned subdomains: ${removedSubdomains.join(', ')}.`
    });
  } else {
    unchangedFields.push('subdomains_infrastructure');
  }

  // ============================================================
  // CHECK 7: Products, Solutions & Services Catalog
  // ============================================================
  if (newRec.products.length > 0 && oldRec.products.length > 0) {
    const oldProdSet = new Set(oldRec.products);
    const addedProducts = newRec.products.filter(p => !oldProdSet.has(p));
    const discontinuedProducts = oldRec.products.filter(p => !newRec.products.includes(p));

    if (addedProducts.length > 0) {
      changes.push({
        field: 'products_and_services',
        old_value: oldRec.products,
        new_value: newRec.products,
        change_type: 'catalog_expanded',
        confidence: 0.92,
        evidence: `Discovered new product routes: ${addedProducts.slice(0, 4).join(', ')}.`
      });
    } else if (discontinuedProducts.length > 0) {
      changes.push({
        field: 'products_and_services',
        old_value: oldRec.products,
        new_value: newRec.products,
        change_type: 'catalog_reduced',
        confidence: 0.90,
        evidence: `Discontinued/removed product routes: ${discontinuedProducts.slice(0, 4).join(', ')}.`
      });
    } else {
      unchangedFields.push('products_and_services');
    }
  }

  // ============================================================
  // CHECK 8: Phone Numbers
  // ============================================================
  if (oldRec.phone && newRec.phone) {
    const oldP = normalizePhone(oldRec.phone);
    const newP = normalizePhone(newRec.phone);
    if (oldP && newP && oldP !== newP) {
      changes.push({
        field: 'phone',
        old_value: oldRec.phone,
        new_value: newRec.phone,
        change_type: 'modified',
        confidence: 0.95,
        evidence: `Phone number changed from "${oldRec.phone}" to "${newRec.phone}".`
      });
    } else {
      unchangedFields.push('phone');
    }
  } else if (!oldRec.phone && newRec.phone) {
    changes.push({
      field: 'phone',
      old_value: null,
      new_value: newRec.phone,
      change_type: 'added',
      confidence: 0.92,
      evidence: `Added contact phone number: "${newRec.phone}".`
    });
  }

  // ============================================================
  // CHECK 9: Email Addresses
  // ============================================================
  if (oldRec.emails.length > 0 && newRec.emails.length > 0) {
    const hasOverlap = oldRec.emails.some(oe => newRec.emails.includes(oe));
    if (!hasOverlap) {
      changes.push({
        field: 'email',
        old_value: oldRec.emails.join(', '),
        new_value: newRec.emails.join(', '),
        change_type: 'modified',
        confidence: 0.90,
        evidence: `Replaced contact email channels with: ${newRec.emails.join(', ')}.`
      });
    } else {
      unchangedFields.push('email');
    }
  }

  // ============================================================
  // CHECK 10: Office Location / Postal Address
  // ============================================================
  if (oldRec.address && newRec.address && oldRec.address !== newRec.address) {
    const addrSim = calculateSimilarity(oldRec.address, newRec.address);
    if (addrSim < 0.60) {
      changes.push({
        field: 'office_address',
        old_value: oldRec.address,
        new_value: newRec.address,
        change_type: 'relocated',
        confidence: 0.92,
        evidence: `Physical office address updated from "${oldRec.address}" to "${newRec.address}".`
      });
    } else {
      noiseDetected.push(`Minor address formatting difference ('${oldRec.address}' vs '${newRec.address}') - ignored.`);
      unchangedFields.push('office_address');
    }
  }

  // ============================================================
  // CHECK 11: Social Media Handles
  // ============================================================
  const socialChanges = [];
  for (const [platform, handle] of Object.entries(newRec.social)) {
    const oldHandle = oldRec.social[platform];
    if (!oldHandle) {
      socialChanges.push(`Added ${platform}: ${handle}`);
    } else if (oldHandle !== handle) {
      socialChanges.push(`Changed ${platform} handle from ${oldHandle} to ${handle}`);
    }
  }
  if (socialChanges.length > 0) {
    changes.push({
      field: 'social_channels',
      old_value: oldRec.social,
      new_value: newRec.social,
      change_type: 'modified',
      confidence: 0.90,
      evidence: socialChanges.join('; ')
    });
  } else {
    unchangedFields.push('social_channels');
  }

  // ============================================================
  // CHECK 12: Careers & Recruitment Portal
  // ============================================================
  if (oldRec.career_link && newRec.career_link && oldRec.career_link !== newRec.career_link) {
    changes.push({
      field: 'career_portal',
      old_value: oldRec.career_link,
      new_value: newRec.career_link,
      change_type: 'modified',
      confidence: 0.88,
      evidence: `Recruitment portal changed to: ${newRec.career_link}.`
    });
  }

  const hasMeaningful = changes.length > 0;
  const summary = hasMeaningful
    ? `Identified ${changes.length} business change(s): ${changes.map(c => c.field).join(', ')}.`
    : 'No business changes detected. Stored baseline snapshot remains fully up-to-date.';

  return {
    domain: newRec.domain || oldRec.domain,
    has_meaningful_change: hasMeaningful,
    summary,
    changes,
    unchanged_fields: unchangedFields,
    noise_detected: noiseDetected,
    requires_human_review: false,
    evaluated_at: new Date().toISOString(),
  };
}

module.exports = {
  compareCrawls,
  normalizeBrandStem,
  normalizePhone,
  calculateSimilarity,
  stripCosmeticNoise,
  extractRecord,
  extractSubdomainsAndPortals,
};


