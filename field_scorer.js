/**
 * Direct Field-by-Field Scoring Engine (field_scorer.js)
 * --------------------------------------------------------
 * Compares old baseline record and fresh crawl snapshot directly field-by-field.
 * No cross-field dependencies, no confusing multi-tier flags.
 *
 * Each field is independently evaluated for:
 * - UNCHANGED (0 pts)
 * - MODIFIED (changed to different value)
 * - NOT_FOUND_IN_CRAWL (existed in old baseline, not extracted in live crawl)
 * - ADDED (newly extracted in live crawl)
 *
 * Total Company Change Score: 0 to 100
 * - 0 - 15:   LOW (Minor / cosmetic updates)
 * - 16 - 39:  MEDIUM (Moderate updates, single contact or wording rewrite)
 * - 40 - 100: HIGH (Major changes, rebrand, relocation or multi-field overhaul)
 */

// Helper: Normalize string (lowercase, trim, collapse whitespace)
function cleanStr(val) {
  if (val === null || val === undefined) return '';
  return String(val).trim().replace(/\s+/g, ' ');
}

// Helper: Tokenize text into unique words for similarity
function tokenize(text) {
  return new Set(
    cleanStr(text)
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 2)
  );
}

// Helper: Compute word-overlap similarity (0.0 to 1.0)
function calculateSimilarity(textA, textB) {
  const tokensA = tokenize(textA);
  const tokensB = tokenize(textB);
  if (tokensA.size === 0 && tokensB.size === 0) return 1.0;
  if (tokensA.size === 0 || tokensB.size === 0) return 0.0;

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  const union = new Set([...tokensA, ...tokensB]).size;
  return union === 0 ? 1.0 : intersection / union;
}

// Helper: Normalize phone digits
function cleanPhone(val) {
  if (!val) return '';
  const digits = String(val).replace(/\D/g, '');
  // Strip leading 0 or country codes like 44 / 1 for comparison
  return digits.replace(/^(00|0|\+)/, '');
}

/**
 * Evaluates companyName directly
 * Weight: 25 pts max
 */
function scoreCompanyName(oldVal, newVal) {
  const oldNorm = cleanStr(oldVal).toLowerCase();
  const newNorm = cleanStr(newVal).toLowerCase();

  if (!oldNorm && !newNorm) {
    return { status: 'NOT_APPLICABLE', score: 0, description: 'No company name in old or new.' };
  }
  if (!oldNorm && newNorm) {
    return { status: 'ADDED', score: 5, description: `Company name newly found: "${newVal}"` };
  }
  if (oldNorm && !newNorm) {
    return {
      status: 'NOT_FOUND_IN_CRAWL',
      score: 10,
      description: `Company name "${oldVal}" was not found in the live crawl.`,
    };
  }
  if (oldNorm === newNorm) {
    return { status: 'UNCHANGED', score: 0, description: 'Company name is identical.' };
  }

  // Changed to a different company name
  return {
    status: 'MODIFIED',
    score: 25,
    description: `Company name changed from "${oldVal}" to "${newVal}".`,
  };
}

/**
 * Evaluates description directly with similarity
 * Weight: 20 pts max
 */
function scoreDescription(oldVal, newVal) {
  const oldDesc = cleanStr(oldVal);
  const newDesc = cleanStr(newVal);

  if (!oldDesc && !newDesc) {
    return { status: 'NOT_APPLICABLE', score: 0, similarity: '100%', description: 'No description in old or new.' };
  }
  if (!oldDesc && newDesc) {
    return { status: 'ADDED', score: 5, similarity: '0%', description: 'Description newly added.' };
  }
  if (oldDesc && !newDesc) {
    return {
      status: 'NOT_FOUND_IN_CRAWL',
      score: 10,
      similarity: '0%',
      description: 'Description not found in the live crawl.',
    };
  }

  const sim = calculateSimilarity(oldDesc, newDesc);
  const pct = Math.round(sim * 100);

  if (sim >= 0.85) {
    return { status: 'UNCHANGED', score: 0, similarity: `${pct}%`, description: 'Description unchanged.' };
  }
  if (sim >= 0.45) {
    return {
      status: 'MINOR_UPDATE',
      score: 5,
      similarity: `${pct}%`,
      description: `Description had minor wording updates (${pct}% similarity).`,
    };
  }
  return {
    status: 'MAJOR_CHANGE',
    score: 20,
    similarity: `${pct}%`,
    description: `Description was substantially rewritten (${pct}% similarity).`,
  };
}

/**
 * Evaluates phone directly
 * Weight: 15 pts max
 */
function scorePhone(oldVal, newVal) {
  const oldP = cleanPhone(oldVal);
  const newP = cleanPhone(newVal);

  if (!oldP && !newP) {
    return { status: 'NOT_APPLICABLE', score: 0, description: 'No phone in old or new.' };
  }
  if (!oldP && newP) {
    return { status: 'ADDED', score: 5, description: `Phone newly discovered: "${newVal}"` };
  }
  if (oldP && !newP) {
    return { status: 'NOT_FOUND_IN_CRAWL', score: 5, description: `Phone "${oldVal}" not found in live crawl.` };
  }
  if (oldP === newP || oldP.endsWith(newP) || newP.endsWith(oldP)) {
    return { status: 'UNCHANGED', score: 0, description: 'Phone number matches.' };
  }

  return {
    status: 'MODIFIED',
    score: 15,
    description: `Phone changed from "${oldVal}" to "${newVal}".`,
  };
}

/**
 * Evaluates email directly
 * Weight: 15 pts max
 */
function scoreEmail(oldVal, newVal) {
  const oldE = cleanStr(oldVal).toLowerCase();
  const newE = cleanStr(newVal).toLowerCase();

  if (!oldE && !newE) {
    return { status: 'NOT_APPLICABLE', score: 0, description: 'No email in old or new.' };
  }
  if (!oldE && newE) {
    return { status: 'ADDED', score: 5, description: `Email newly found: "${newVal}"` };
  }
  if (oldE && !newE) {
    return { status: 'NOT_FOUND_IN_CRAWL', score: 5, description: `Email "${oldVal}" not found in live crawl.` };
  }
  if (oldE === newE) {
    return { status: 'UNCHANGED', score: 0, description: 'Email address matches.' };
  }

  return {
    status: 'MODIFIED',
    score: 15,
    description: `Email changed from "${oldVal}" to "${newVal}".`,
  };
}

/**
 * Evaluates address directly
 * Weight: 15 pts max
 */
function scoreAddress(oldVal, newVal) {
  const oldA = cleanStr(oldVal);
  const newA = cleanStr(newVal);

  if (!oldA && !newA) {
    return { status: 'NOT_APPLICABLE', score: 0, description: 'No address in old or new.' };
  }
  if (!oldA && newA) {
    return { status: 'ADDED', score: 5, description: `Address newly found: "${newVal}"` };
  }
  if (oldA && !newA) {
    return { status: 'NOT_FOUND_IN_CRAWL', score: 5, description: `Address "${oldVal}" not found in live crawl.` };
  }

  const sim = calculateSimilarity(oldA, newA);
  const pct = Math.round(sim * 100);

  if (sim >= 0.7) {
    return { status: 'UNCHANGED', score: 0, similarity: `${pct}%`, description: 'Address matches.' };
  }

  return {
    status: 'MODIFIED',
    score: 15,
    similarity: `${pct}%`,
    description: `Address changed from "${oldVal}" to "${newVal}".`,
  };
}

/**
 * Evaluates page title directly
 * Weight: 10 pts max
 */
function scoreTitle(oldVal, newVal) {
  const oldT = cleanStr(oldVal);
  const newT = cleanStr(newVal);

  if (!oldT && !newT) {
    return { status: 'NOT_APPLICABLE', score: 0, description: 'No title in old or new.' };
  }
  if (!oldT && newT) {
    return { status: 'ADDED', score: 5, description: `Title newly found: "${newVal}"` };
  }
  if (oldT && !newT) {
    return { status: 'NOT_FOUND_IN_CRAWL', score: 5, description: 'Title not found in live crawl.' };
  }

  const sim = calculateSimilarity(oldT, newT);
  const pct = Math.round(sim * 100);

  if (sim >= 0.75) {
    return { status: 'UNCHANGED', score: 0, similarity: `${pct}%`, description: 'Title matches.' };
  }

  return {
    status: 'MODIFIED',
    score: 10,
    similarity: `${pct}%`,
    description: `Title changed from "${oldVal}" to "${newVal}".`,
  };
}

/**
 * Evaluates URL / Website redirection
 * Weight: 20 pts max
 */
function scoreUrl(oldUrl, newUrl) {
  const cleanU = (u) => {
    try {
      const parsed = new URL(u.startsWith('http') ? u : `https://${u}`);
      return parsed.hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      return cleanStr(u).toLowerCase();
    }
  };

  const hostOld = cleanU(oldUrl);
  const hostNew = cleanU(newUrl);

  if (!hostOld || !hostNew || hostOld === hostNew) {
    return { status: 'UNCHANGED', score: 0, description: 'Domain / host matches.' };
  }

  return {
    status: 'REDIRECTED',
    score: 20,
    description: `Website domain redirected from "${hostOld}" to "${hostNew}".`,
  };
}

/**
 * Main Direct Field Scorer
 * Takes the old record and new record (from crawler data[0] or DB profile)
 * and returns a clear, transparent scored report.
 */
function scoreCompanyChanges(oldRecord = {}, newRecord = {}) {
  // Extract values directly for each field
  const oldCompany = oldRecord.companyName || oldRecord.name || oldRecord.company_name || null;
  const newCompany = newRecord.companyName || newRecord.name || newRecord.company_name || null;

  const oldDesc = oldRecord.description || oldRecord.summary || null;
  const newDesc = newRecord.description || newRecord.summary || null;

  const oldPhone = oldRecord.phone || oldRecord.phoneFormatted || null;
  const newPhone = newRecord.phone || newRecord.phoneFormatted || null;

  const oldEmail = oldRecord.email || oldRecord.genericEmail || null;
  const newEmail = newRecord.email || newRecord.genericEmail || null;

  const oldAddress = oldRecord.address || null;
  const newAddress = newRecord.address || null;

  const oldTitle = oldRecord.title || null;
  const newTitle = newRecord.title || null;

  const oldUrl = oldRecord.url || oldRecord.website || null;
  const newUrl = newRecord.url || newRecord.website || null;

  // Compute field scores directly
  const fields = {
    company_name: {
      old: oldCompany,
      new: newCompany,
      ...scoreCompanyName(oldCompany, newCompany),
    },
    description: {
      old: oldDesc,
      new: newDesc,
      ...scoreDescription(oldDesc, newDesc),
    },
    phone: {
      old: oldPhone,
      new: newPhone,
      ...scorePhone(oldPhone, newPhone),
    },
    email: {
      old: oldEmail,
      new: newEmail,
      ...scoreEmail(oldEmail, newEmail),
    },
    address: {
      old: oldAddress,
      new: newAddress,
      ...scoreAddress(oldAddress, newAddress),
    },
    title: {
      old: oldTitle,
      new: newTitle,
      ...scoreTitle(oldTitle, newTitle),
    },
    website: {
      old: oldUrl,
      new: newUrl,
      ...scoreUrl(oldUrl, newUrl),
    },
  };

  // Calculate total change score
  let totalScore = 0;
  for (const key of Object.keys(fields)) {
    totalScore += fields[key].score || 0;
  }
  totalScore = Math.min(100, totalScore);

  // Determine change level
  let changeLevel = 'LOW';
  if (totalScore >= 40) {
    changeLevel = 'HIGH';
  } else if (totalScore >= 16) {
    changeLevel = 'MEDIUM';
  }

  // Meaningful change flag: true if score >= 25 or major rebrand/relocation
  const hasMeaningfulChange =
    totalScore >= 25 ||
    fields.company_name.status === 'MODIFIED' ||
    fields.website.status === 'REDIRECTED' ||
    fields.address.status === 'MODIFIED';

  // Human-readable summary
  const changedList = Object.entries(fields)
    .filter(([_, v]) => v.status === 'MODIFIED' || v.status === 'MAJOR_CHANGE' || v.status === 'REDIRECTED')
    .map(([k]) => k.replace('_', ' '));

  const missingList = Object.entries(fields)
    .filter(([_, v]) => v.status === 'NOT_FOUND_IN_CRAWL')
    .map(([k]) => k.replace('_', ' '));

  let summaryParts = [];
  if (changedList.length > 0) {
    summaryParts.push(`Changed: ${changedList.join(', ')}`);
  }
  if (missingList.length > 0) {
    summaryParts.push(`Not found in crawl: ${missingList.join(', ')}`);
  }
  if (summaryParts.length === 0) {
    summaryParts.push('All evaluated fields match the baseline.');
  }

  return {
    total_change_score: totalScore,
    change_level: changeLevel,
    has_meaningful_change: hasMeaningfulChange,
    summary: summaryParts.join(' | '),
    fields,
  };
}

module.exports = {
  scoreCompanyChanges,
  scoreCompanyName,
  scoreDescription,
  scorePhone,
  scoreEmail,
  scoreAddress,
  scoreTitle,
  scoreUrl,
  calculateSimilarity,
};
