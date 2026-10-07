/**
 * Centralized Field Analysis Configuration (src/config/field_analysis_config.js)
 * --------------------------------------------------------------------------------
 * Categorizes fields into types and defines:
 * - Field Type: IDENTITY | CONTACT | LOCATION | NUMERIC | TEXT | URL | LIST | STRUCTURED | TECHNICAL
 * - Importance: CRITICAL | HIGH | MEDIUM | LOW | IGNORE
 * - Allowed Signals: Which of the 6 signals are permissible for this field
 * - Normalization rules: e.g. phone formatting, case folding, empty-value tolerance
 */

const FIELD_TYPES = {
  IDENTITY: 'IDENTITY',
  CONTACT: 'CONTACT',
  LOCATION: 'LOCATION',
  NUMERIC: 'NUMERIC',
  TEXT: 'TEXT',
  URL: 'URL',
  LIST: 'LIST',
  STRUCTURED: 'STRUCTURED',
  TECHNICAL: 'TECHNICAL',
  UNKNOWN: 'UNKNOWN'
};

const IMPORTANCE_LEVELS = {
  CRITICAL: 'CRITICAL',
  HIGH: 'HIGH',
  MEDIUM: 'MEDIUM',
  LOW: 'LOW',
  IGNORE: 'IGNORE'
};

/**
 * Exact or prefix patterns mapped to field metadata
 */
const FIELD_DEFINITIONS = [
  // 1. IDENTITY FIELDS (Company name, legal name, clearbit, brand identity)
  {
    pattern: /^(companyName|company_name|legalName|legal_name|name|clearbitName|nameFromTitle|nameFromCopyright)$/i,
    fieldType: FIELD_TYPES.IDENTITY,
    importance: IMPORTANCE_LEVELS.CRITICAL,
    allowedSignals: ['entity_changes'],
    label: 'Company Name / Identity'
  },

  // 2. CONTACT FIELDS (Phone, email, fax)
  {
    pattern: /^(phone|phoneFormatted|mobile|fax|faxFormatted)$/i,
    fieldType: FIELD_TYPES.CONTACT,
    contactSubtype: 'PHONE',
    importance: IMPORTANCE_LEVELS.HIGH,
    allowedSignals: ['entity_changes'],
    label: 'Phone Number'
  },
  {
    pattern: /^(email|emails|contactEmail|genericEmail|nonGenericEmail)$/i,
    fieldType: FIELD_TYPES.CONTACT,
    contactSubtype: 'EMAIL',
    importance: IMPORTANCE_LEVELS.HIGH,
    allowedSignals: ['entity_changes'],
    label: 'Email Address'
  },

  // 3. LOCATION FIELDS (Country, address, city, postcode)
  {
    pattern: /^(country|ipCountry)$/i,
    fieldType: FIELD_TYPES.LOCATION,
    locationSubtype: 'COUNTRY',
    importance: IMPORTANCE_LEVELS.HIGH,
    allowedSignals: ['entity_changes'],
    label: 'Country'
  },
  {
    pattern: /^(address|postal_code|postcode|city|state)$/i,
    fieldType: FIELD_TYPES.LOCATION,
    locationSubtype: 'ADDRESS',
    importance: IMPORTANCE_LEVELS.HIGH,
    allowedSignals: ['entity_changes'],
    label: 'Address & Location'
  },

  // 4. NUMERIC / STATUTORY FACT
  {
    pattern: /^(registration_number|company_number|registrationNumber)$/i,
    fieldType: FIELD_TYPES.NUMERIC,
    numericSubtype: 'REGISTRATION',
    importance: IMPORTANCE_LEVELS.CRITICAL,
    allowedSignals: ['entity_changes', 'number_changes'],
    label: 'Registration Number'
  },
  {
    pattern: /^(founded_year|employee_count|company_size|revenue|loadTimeMs)$/i,
    fieldType: FIELD_TYPES.NUMERIC,
    numericSubtype: 'METRIC',
    importance: IMPORTANCE_LEVELS.MEDIUM,
    allowedSignals: ['number_changes'],
    label: 'Business Metric'
  },

  // 5. NATURAL LANGUAGE TEXT (Only here do all 6 signals apply!)
  {
    pattern: /^(description|summary|tagline|about|mission|business_description|aboutPage|termsPage|privacyPage|homeContent|contactPage)$/i,
    fieldType: FIELD_TYPES.TEXT,
    importance: IMPORTANCE_LEVELS.LOW, // Default editorial importance; description can rise if material
    allowedSignals: [
      'embedding_semantic_similarity',
      'tfidf_cosine_similarity',
      'jaccard_similarity',
      'number_changes',
      'negation_changes',
      'entity_changes'
    ],
    label: 'Editorial & Page Content'
  },
  {
    pattern: /^(title)$/i,
    fieldType: FIELD_TYPES.TEXT,
    importance: IMPORTANCE_LEVELS.LOW,
    allowedSignals: [
      'embedding_semantic_similarity',
      'tfidf_cosine_similarity',
      'jaccard_similarity',
      'number_changes',
      'negation_changes',
      'entity_changes'
    ],
    label: 'Page Title'
  },
  {
    pattern: /^(products|services|products_services_c)$/i,
    fieldType: FIELD_TYPES.TEXT,
    importance: IMPORTANCE_LEVELS.MEDIUM,
    allowedSignals: [
      'embedding_semantic_similarity',
      'tfidf_cosine_similarity',
      'jaccard_similarity',
      'number_changes',
      'negation_changes',
      'entity_changes'
    ],
    label: 'Products & Services'
  },

  // 6. URL & SOCIAL MEDIA
  {
    pattern: /^(website|url)$/i,
    fieldType: FIELD_TYPES.URL,
    importance: IMPORTANCE_LEVELS.HIGH,
    allowedSignals: [],
    label: 'Website URL'
  },
  {
    pattern: /^(linkedin|facebook|instagram|twitter|youtube|tiktok|socialLinks.*|domainMatchedSocialLinks.*)$/i,
    fieldType: FIELD_TYPES.URL,
    importance: IMPORTANCE_LEVELS.LOW,
    allowedSignals: [],
    label: 'Social Link'
  },
  {
    pattern: /^(aboutLinks.*|contactLinks.*|termsLinks.*|privacyLinks.*|ecommerceLinks.*|homeLinks.*|otherLinks.*)$/i,
    fieldType: FIELD_TYPES.URL,
    importance: IMPORTANCE_LEVELS.LOW,
    allowedSignals: [],
    label: 'Site Navigation Link'
  },

  // 7. TECHNICAL / TELEMETRY (Ignore as noise)
  {
    pattern: /^(processingId|hostIp|webServer|pingerInfo|domainStatus|comments|redirection|responseCode|language)$/i,
    fieldType: FIELD_TYPES.TECHNICAL,
    importance: IMPORTANCE_LEVELS.IGNORE,
    allowedSignals: [],
    label: 'Crawl Telemetry'
  }
];

/**
 * Resolves configuration for any field path (including nested paths like socialLinks.facebook)
 */
function getFieldConfig(fieldPath) {
  if (!fieldPath) {
    return {
      fieldType: FIELD_TYPES.UNKNOWN,
      importance: IMPORTANCE_LEVELS.LOW,
      allowedSignals: [],
      label: 'Unknown Field'
    };
  }

  const cleanPath = String(fieldPath).trim();
  const topKey = cleanPath.split('.')[0];
  const lastKey = cleanPath.split('.').pop();

  for (const def of FIELD_DEFINITIONS) {
    if (def.pattern.test(cleanPath) || def.pattern.test(topKey) || def.pattern.test(lastKey)) {
      return def;
    }
  }

  // Fallback defaults
  return {
    fieldType: FIELD_TYPES.UNKNOWN,
    importance: IMPORTANCE_LEVELS.LOW,
    allowedSignals: ['jaccard_similarity'],
    label: cleanPath
  };
}

module.exports = {
  FIELD_TYPES,
  IMPORTANCE_LEVELS,
  getFieldConfig,
  FIELD_DEFINITIONS
};

