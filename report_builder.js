/**
 * Report Builder & HTML Renderer
 * --------------------------------
 * Produces structured report objects and self-contained, print-friendly
 * executive reports for bank team members in plain, non-technical language.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Diff = require('diff');

// Load banking wording configuration
let WORDING = {};
try {
  const wordingPath = path.resolve(__dirname, 'config/report_wording.json');
  WORDING = JSON.parse(fs.readFileSync(wordingPath, 'utf8'));
} catch (err) {
  // Safe fallback if config file is not yet loaded
  WORDING = {
    verdicts: {},
    confidence_levels: {},
    change_categories: {},
    reasons: {},
    labels: {}
  };
}

/**
 * Format date as "12 Aug 2026"
 */
function formatReportDate(val) {
  if (!val) return '—';
  const d = (val instanceof Date) ? val : new Date(val);
  if (isNaN(d.getTime())) return String(val);
  const day = d.getUTCDate();
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[d.getUTCMonth()];
  const year = d.getUTCFullYear();
  return `${day} ${month} ${year}`;
}

/**
 * Express small numbers (0-10) in words
 */
function numberToWord(n) {
  const words = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
  return (n >= 0 && n <= 10) ? words[n] : String(n);
}

/**
 * Escape text for safe HTML injection
 */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Format arbitrary display values safely without printing null/undefined
 */
function formatDisplayValue(val) {
  if (val === null || val === undefined || val === '') return '—';
  if (typeof val === 'object') {
    if (Array.isArray(val)) {
      if (val.length === 0) return '—';
      return val.map(v => formatDisplayValue(v)).join(', ');
    }
    const entries = Object.entries(val).map(([k, v]) => `${k}: ${formatDisplayValue(v)}`);
    return entries.length > 0 ? entries.join('; ') : '—';
  }
  const s = String(val).trim();
  if (s === 'null' || s === 'undefined' || s === '') return '—';
  return s;
}

/**
 * Retrieve friendly label for an item
 */
function getItemLabel(field) {
  if (!field) return 'Profile item';
  if (WORDING.labels && WORDING.labels[field]) {
    return WORDING.labels[field];
  }
  // Remove dot notations and clean up
  const clean = field.replace(/^otherLinks\./, '').replace(/([A-Z])/g, ' $1');
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/**
 * Map confidence score (0.0 - 1.0) to plain language
 */
function getConfidenceLabel(score) {
  if (typeof score !== 'number') return WORDING.confidence_levels?.high || 'High confidence';
  if (score >= 0.85) return WORDING.confidence_levels?.high || 'High confidence';
  if (score >= 0.70) return WORDING.confidence_levels?.moderate || 'Moderate confidence';
  return WORDING.confidence_levels?.low || 'Preliminary observation';
}

/**
 * Map change category for banking context
 */
function getChangeCategoryInfo(field, changeType) {
  const categories = WORDING.change_categories || {};
  if (field === 'registration_number') return categories.registration_number;
  if (field === 'companyName' || field === 'name') {
    return changeType === 'rebrand' ? categories.rebrand : categories.legal_entity;
  }
  if (field === 'address' || changeType === 'office_relocated') {
    return categories.office_relocated || categories.address;
  }
  if (field && field.toLowerCase().includes('phone')) return categories.phone;
  if (field && field.toLowerCase().includes('email')) return categories.email;
  if (field === 'url' || field === 'redirection' || changeType === 'domain_redirect') {
    return categories.domain_redirect;
  }
  if (changeType === 'site_down' || (field === 'domainStatus' && changeType !== 'site_parked')) {
    return categories.site_down;
  }
  if (changeType === 'site_parked') return categories.site_parked;
  if (field === 'catalog_routes' || field === 'productLinks' || field === 'serviceLinks') {
    return categories.catalog_expanded;
  }
  if (field === 'subdomain') return categories.subdomain;
  if (field === 'description' || field === 'homeContent') return categories.description;

  return categories.general || {
    label: getItemLabel(field),
    why_it_matters: 'Informational adjustment reflecting public website maintenance.',
    recommended_action: 'Save to client file for future reference.'
  };
}

/**
 * Map reason codes to friendly non-technical explanations
 */
function getReasonText(reasonCode) {
  const reasons = WORDING.reasons || {};
  if (!reasonCode) return reasons.wording_edit || 'Minor wording adjustment';
  if (reasons[reasonCode]) return reasons[reasonCode];
  const lower = String(reasonCode).toLowerCase();
  if (lower.includes('legal suffix')) return reasons.legal_suffix;
  if (lower.includes('whitespace')) return reasons.whitespace;
  if (lower.includes('tracking')) return reasons.tracking_param;
  if (lower.includes('stale') || lower.includes('meta')) return reasons.baseline_stale_meta;
  if (lower.includes('coverage')) return reasons.coverage_difference;
  if (lower.includes('structure')) return reasons.structure_shift;
  return reasons.wording_edit || 'Minor wording adjustment';
}

/**
 * Sanitize evidence strings for bank members
 */
function sanitizeEvidence(evidenceStr) {
  if (!evidenceStr) return '';
  let clean = String(evidenceStr);
  clean = clean.replace(/Jaccard\s*/gi, 'Word match ratio ');
  clean = clean.replace(/E\.164\s*/gi, 'International format ');
  clean = clean.replace(/DNS\s*/gi, 'Network address ');
  clean = clean.replace(/crawler|crawl|scrape/gi, 'check');
  clean = clean.replace(/baseline/gi, 'previous record');
  clean = clean.replace(/hash/gi, 'code');
  clean = clean.replace(/tier|threshold/gi, 'standard');
  clean = clean.replace(/null|undefined/gi, 'none');
  return clean;
}

/**
 * Compute word-level inline diff using Diff.diffWords
 */
function computeWordDiff(before, after) {
  const beforeStr = before != null ? String(before).trim() : '';
  const afterStr = after != null ? String(after).trim() : '';

  const parts = Diff.diffWords(beforeStr, afterStr);
  let wordsAdded = 0;
  let wordsRemoved = 0;
  let wordsSame = 0;

  const segments = parts.map(part => {
    const type = part.added ? 'added' : part.removed ? 'removed' : 'same';
    const count = part.value.trim().split(/\s+/).filter(Boolean).length;
    if (part.added) wordsAdded += count;
    else if (part.removed) wordsRemoved += count;
    else wordsSame += count;
    return { type, text: part.value };
  });

  const totalWords = Math.max(wordsSame + wordsRemoved, wordsSame + wordsAdded, 1);
  const similarity_pct = Math.max(0, Math.min(100, Math.round((wordsSame / totalWords) * 100)));

  return {
    segments,
    words_added: wordsAdded,
    words_removed: wordsRemoved,
    similarity_pct
  };
}

/**
 * Checks if a value appears on secondary body pages (contactPage, aboutPage, etc.)
 */
function isPresentInSecondaryPages(field, oldVal, newRecord) {
  if (!oldVal || !newRecord) return false;
  const strVal = String(oldVal).trim();
  if (!strVal || strVal === 'null' || strVal === 'undefined') return false;

  const pages = [
    newRecord.contactPage,
    newRecord.aboutPage,
    newRecord.homeContent,
    newRecord.privacyPage,
    newRecord.termsPage
  ].filter(Boolean);

  if (pages.length === 0) return false;

  // Exact substring
  for (const page of pages) {
    if (page.includes(strVal)) return true;
  }

  // Phone digit comparison
  if (field && field.toLowerCase().includes('phone')) {
    const digits = strVal.replace(/\D/g, '');
    if (digits.length >= 7) {
      for (const page of pages) {
        const pageDigits = page.replace(/\D/g, '');
        if (pageDigits.includes(digits)) return true;
      }
    }
  }

  // Postcode comparison
  if (field === 'postal_code' || field === 'address') {
    const pcMatch = strVal.match(/\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i);
    if (pcMatch) {
      const pc = pcMatch[1].replace(/\s+/g, '').toUpperCase();
      for (const page of pages) {
        const cleaned = page.replace(/\s+/g, '').toUpperCase();
        if (cleaned.includes(pc)) return true;
      }
    }
  }

  return false;
}

/**
 * Build structured report object (Pure, synchronous)
 */
function buildReport(comparisonResult, oldRecord, newRecord) {
  const comp = comparisonResult || {};
  const oldData = (oldRecord && oldRecord.crawl_data && oldRecord.crawl_data.data && oldRecord.crawl_data.data[0]) ||
                  (oldRecord && oldRecord.data && oldRecord.data[0]) ||
                  oldRecord || {};
  const newData = (newRecord && newRecord.crawl_data && newRecord.crawl_data.data && newRecord.crawl_data.data[0]) ||
                  (newRecord && newRecord.data && newRecord.data[0]) ||
                  newRecord || {};

  const domain = comp.domain || newData.normalizedDomain || oldData.normalizedDomain || '';
  const company = newData.companyName || newData.name || oldData.companyName || oldData.name ||
                  newData.nameFromTitle || oldData.nameFromTitle || newData.clearbitName || domain;

  const scanned_at = comp.compared_at || new Date().toISOString();
  const baseline_date = comp.baseline_crawled_at || oldData.crawled_at || null;
  const baseline_age_days = typeof comp.baseline_age_days === 'number' ? comp.baseline_age_days : 0;
  const baseline_quality = comp.baseline_quality || 'good';

  // Determine verdict
  let verdict = 'no_material_change';
  if (comp.status === 'inconclusive') {
    verdict = 'could_not_verify';
  } else {
    const rawChanges = Array.isArray(comp.changes) ? comp.changes : [];
    const hasAlert = rawChanges.some(c => c.tier === 'alert');
    const hasPending = rawChanges.some(c => c.tier === 'alert_if_confirmed' || c.needs_confirmation === true);
    if (hasAlert) {
      verdict = 'action_needed';
    } else if (hasPending) {
      verdict = 'review_recommended';
    } else {
      verdict = 'no_material_change';
    }
  }

  const needs_attention = [];
  const review_recommended = [];
  const minor_changes = [];
  const could_not_verify = [];
  const unchanged = [];
  const field_table = [];

  // If status is inconclusive, do not claim any changes
  if (comp.status === 'inconclusive') {
    could_not_verify.push({
      field: 'website_connectivity',
      label: 'Website Connectivity',
      before: 'Operational',
      after: null,
      description: "Today's check could not verify the website content due to temporary connection limitations.",
      status: 'could_not_verify',
      reason: comp.reason || 'inconclusive'
    });
  } else {
    const rawChanges = Array.isArray(comp.changes) ? comp.changes : [];
    const rawNoise = Array.isArray(comp.noise_detected) ? comp.noise_detected : [];
    const rawNotFound = Array.isArray(comp.not_found_fields) ? comp.not_found_fields : [];
    const rawUnchanged = Array.isArray(comp.unchanged_fields) ? comp.unchanged_fields : [];
    const rawGaps = Array.isArray(comp.baseline_gaps) ? comp.baseline_gaps : [];

    // Process high & medium priority changes
    for (const c of rawChanges) {
      const catInfo = getChangeCategoryInfo(c.field, c.change_type);
      const diffInfo = computeWordDiff(c.old_value, c.new_value);
      const evidenceList = Array.isArray(c.evidence)
        ? c.evidence.map(sanitizeEvidence)
        : (c.evidence ? [sanitizeEvidence(c.evidence)] : []);

      const item = {
        field: c.field,
        label: getItemLabel(c.field),
        before: formatDisplayValue(c.old_value),
        after: formatDisplayValue(c.new_value),
        description: c.description || '',
        tier: c.tier,
        confidence: c.confidence != null ? c.confidence : 0.8,
        confidence_label: getConfidenceLabel(c.confidence),
        evidence_sources: evidenceList,
        why_it_matters: catInfo.why_it_matters,
        recommended_action: catInfo.recommended_action,
        diff: diffInfo,
        change_id: c.change_id || ''
      };

      if (c.tier === 'alert') {
        needs_attention.push(item);
      } else if (c.tier === 'alert_if_confirmed' || c.needs_confirmation === true) {
        review_recommended.push(item);
      } else {
        // Log-only text change becomes minor change
        let reasonKey = 'baseline_stale_meta';
        if (c.field === 'title' || c.field === 'description') reasonKey = 'wording_edit';
        item.reason = reasonKey;
        item.reason_label = getReasonText(reasonKey);
        minor_changes.push(item);
      }
    }

    // Process noise items into minor changes
    for (const n of rawNoise) {
      const diffInfo = computeWordDiff(n.old_value, n.new_value);
      let reasonKey = 'wording_edit';
      if (n.reason) {
        const lower = String(n.reason).toLowerCase();
        if (lower.includes('legal suffix')) reasonKey = 'legal_suffix';
        else if (lower.includes('whitespace')) reasonKey = 'whitespace';
        else if (lower.includes('tracking')) reasonKey = 'tracking_param';
        else if (lower.includes('stale') || lower.includes('meta')) reasonKey = 'baseline_stale_meta';
        else if (lower.includes('coverage')) reasonKey = 'coverage_difference';
        else if (lower.includes('structure')) reasonKey = 'structure_shift';
      }

      minor_changes.push({
        field: n.field,
        label: getItemLabel(n.field),
        before: formatDisplayValue(n.old_value),
        after: formatDisplayValue(n.new_value),
        description: `Minor styling update: ${n.field}`,
        tier: 'log_only',
        confidence: 0.9,
        confidence_label: getConfidenceLabel(0.9),
        evidence_sources: ['Styling and formatting check'],
        why_it_matters: 'Cosmetic update with no impact on corporate identity.',
        recommended_action: 'No action required; recorded for completeness.',
        reason: reasonKey,
        reason_label: getReasonText(reasonKey),
        diff: diffInfo
      });
    }

    // Process unchanged items
    for (const u of rawUnchanged) {
      const val = newData[u] !== undefined ? newData[u] : oldData[u];
      unchanged.push({
        field: u,
        label: getItemLabel(u),
        value: formatDisplayValue(val),
        status: 'unchanged',
        note: 'Verified consistent'
      });
    }

    // Process not-found and baseline gap items
    const checkedNotFound = new Set();
    const candidateNotFound = [...rawNotFound];
    for (const g of rawGaps) {
      if (g.field && !candidateNotFound.includes(g.field)) {
        candidateNotFound.push(g.field);
      }
    }

    for (const fn of candidateNotFound) {
      if (checkedNotFound.has(fn)) continue;
      checkedNotFound.add(fn);

      const oldVal = oldData[fn];
      // Check if present on contact page or secondary pages
      if (isPresentInSecondaryPages(fn, oldVal, newData)) {
        unchanged.push({
          field: fn,
          label: getItemLabel(fn),
          value: formatDisplayValue(oldVal),
          status: 'unchanged',
          note: 'verified on contact page'
        });
      } else {
        could_not_verify.push({
          field: fn,
          label: getItemLabel(fn),
          before: formatDisplayValue(oldVal),
          after: '—',
          description: "not found in latest scan, which is not a sign it was removed.",
          status: 'could_not_verify',
          reason: 'not_found'
        });
      }
    }
  }

  // Populate comprehensive field_table
  const allFieldsTracked = [
    'companyName', 'registration_number', 'address', 'postal_code',
    'phone', 'email', 'title', 'description', 'url', 'domainStatus',
    'subdomain', 'catalog_routes', 'homeContent'
  ];

  // Helper to check existing status
  for (const f of allFieldsTracked) {
    const na = needs_attention.find(i => i.field === f);
    if (na) {
      field_table.push({
        field: f,
        label: na.label,
        before: na.before,
        after: na.after,
        status: 'needs_attention',
        status_label: 'Action Needed',
        summary: na.description
      });
      continue;
    }

    const rr = review_recommended.find(i => i.field === f);
    if (rr) {
      field_table.push({
        field: f,
        label: rr.label,
        before: rr.before,
        after: rr.after,
        status: 'review_recommended',
        status_label: 'Review Recommended',
        summary: rr.description
      });
      continue;
    }

    const mc = minor_changes.find(i => i.field === f);
    if (mc) {
      field_table.push({
        field: f,
        label: mc.label,
        before: mc.before,
        after: mc.after,
        status: 'minor_change',
        status_label: 'Minor Update',
        summary: mc.reason_label
      });
      continue;
    }

    const cnv = could_not_verify.find(i => i.field === f);
    if (cnv) {
      field_table.push({
        field: f,
        label: cnv.label,
        before: cnv.before,
        after: '—',
        status: 'could_not_verify',
        status_label: 'Unverified',
        summary: 'Not found in latest scan'
      });
      continue;
    }

    const unc = unchanged.find(i => i.field === f);
    if (unc) {
      field_table.push({
        field: f,
        label: unc.label,
        before: unc.value,
        after: unc.value,
        status: 'unchanged',
        status_label: 'Unchanged',
        summary: unc.note
      });
      continue;
    }

    // Default fallback from records if present
    const oldV = formatDisplayValue(oldData[f]);
    const newV = formatDisplayValue(newData[f]);
    if (oldV !== '—' || newV !== '—') {
      const isIdentical = oldV === newV;
      field_table.push({
        field: f,
        label: getItemLabel(f),
        before: oldV,
        after: newV,
        status: isIdentical ? 'unchanged' : 'could_not_verify',
        status_label: isIdentical ? 'Unchanged' : 'Unverified',
        summary: isIdentical ? 'Consistent' : 'Not found in latest scan'
      });
    }
  }

  // Audit technical metadata
  const change_ids = (comp.changes || []).map(c => c.change_id).filter(Boolean);
  const old_sha256 = crypto.createHash('sha256').update(JSON.stringify(oldRecord || {})).digest('hex');
  const new_sha256 = crypto.createHash('sha256').update(JSON.stringify(newRecord || {})).digest('hex');

  const counts = {
    needs_attention: needs_attention.length,
    review_recommended: review_recommended.length,
    minor: minor_changes.length,
    could_not_verify: could_not_verify.length,
    unchanged: unchanged.length
  };

  return {
    company: String(company || 'Company Profile'),
    domain: String(domain || ''),
    scanned_at,
    baseline_date,
    baseline_age_days,
    baseline_quality,
    verdict,
    counts,
    needs_attention,
    review_recommended,
    minor_changes,
    could_not_verify,
    unchanged,
    field_table,
    audit: {
      comparator_version: '2.0.0',
      change_ids,
      old_sha256,
      new_sha256
    }
  };
}

/**
 * Render word diff segments as HTML string
 */
function renderInlineDiffHtml(diff) {
  if (!diff || !diff.segments) return '';
  return diff.segments.map(seg => {
    const escaped = escapeHtml(seg.text);
    if (seg.type === 'added') {
      return `<ins class="diff-add">${escaped}</ins>`;
    }
    if (seg.type === 'removed') {
      return `<del class="diff-del">${escaped}</del>`;
    }
    return escaped;
  }).join('');
}

/**
 * Render self-contained, print-friendly HTML document
 */
function renderReportHtml(report) {
  const r = report || {};
  const verdictConfig = (WORDING.verdicts && WORDING.verdicts[r.verdict]) || {
    badge: 'Under Review',
    summary: 'Report analysis completed.',
    class: 'verdict-review'
  };

  const formattedScannedDate = formatReportDate(r.scanned_at);
  const formattedPriorDate = formatReportDate(r.baseline_date);
  const priorAgeDays = r.baseline_age_days != null ? `${r.baseline_age_days} days` : '0 days';

  // Count narrative
  let countNarrative = '';
  if (r.verdict === 'action_needed') {
    countNarrative = `${numberToWord(r.counts.needs_attention)} items require prompt verification against customer records.`;
  } else if (r.verdict === 'review_recommended') {
    countNarrative = `${numberToWord(r.counts.review_recommended)} changes are worth a check during your next customer review.`;
  } else if (r.verdict === 'could_not_verify') {
    countNarrative = 'Website verification was inconclusive in today\'s check.';
  } else {
    countNarrative = 'Customer records remain consistent with no material changes.';
  }

  // HTML assembly
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Customer Profile Review - ${escapeHtml(r.company)}</title>
  <style>
    :root {
      --bg-page: #f8fafc;
      --bg-surface: #ffffff;
      --border-subtle: #e2e8f0;
      --border-accent: #cbd5e1;
      --text-main: #0f172a;
      --text-muted: #64748b;
      --badge-action-bg: #fee2e2;
      --badge-action-text: #991b1b;
      --badge-action-border: #fca5a5;
      --badge-review-bg: #fef3c7;
      --badge-review-text: #92400e;
      --badge-review-border: #fcd34d;
      --badge-stable-bg: #dcfce7;
      --badge-stable-text: #166534;
      --badge-stable-border: #86efac;
      --badge-unverified-bg: #f1f5f9;
      --badge-unverified-text: #475569;
      --badge-unverified-border: #cbd5e1;
      --diff-add-bg: #dcfce7;
      --diff-add-text: #166534;
      --diff-del-bg: #fee2e2;
      --diff-del-text: #991b1b;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg-page: #0f172a;
        --bg-surface: #1e293b;
        --border-subtle: #334155;
        --border-accent: #475569;
        --text-main: #f8fafc;
        --text-muted: #94a3b8;
        --badge-action-bg: #450a0a;
        --badge-action-text: #fecaca;
        --badge-action-border: #7f1d1d;
        --badge-review-bg: #451a03;
        --badge-review-text: #fde68a;
        --badge-review-border: #78350f;
        --badge-stable-bg: #052e16;
        --badge-stable-text: #bbf7d0;
        --badge-stable-border: #14532d;
        --badge-unverified-bg: #1e293b;
        --badge-unverified-text: #cbd5e1;
        --badge-unverified-border: #475569;
        --diff-add-bg: #064e3b;
        --diff-add-text: #a7f3d0;
        --diff-del-bg: #7f1d1d;
        --diff-del-text: #fecaca;
      }
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: var(--bg-page);
      color: var(--text-main);
      line-height: 1.5;
      padding: 32px 20px;
    }
    .report-wrapper {
      max-width: 960px;
      margin: 0 auto;
    }

    /* Header */
    .header-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 12px;
      padding: 28px;
      margin-bottom: 24px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    .header-top {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 16px;
      flex-wrap: wrap;
      margin-bottom: 20px;
    }
    .company-title {
      font-size: 26px;
      font-weight: 700;
      color: var(--text-main);
      margin-bottom: 4px;
    }
    .company-meta {
      font-size: 14px;
      color: var(--text-muted);
    }
    .priority-badge {
      display: inline-flex;
      align-items: center;
      padding: 6px 14px;
      border-radius: 9999px;
      font-weight: 600;
      font-size: 14px;
      border: 1px solid transparent;
    }
    .verdict-action {
      background: var(--badge-action-bg);
      color: var(--badge-action-text);
      border-color: var(--badge-action-border);
    }
    .verdict-review {
      background: var(--badge-review-bg);
      color: var(--badge-review-text);
      border-color: var(--badge-review-border);
    }
    .verdict-stable {
      background: var(--badge-stable-bg);
      color: var(--badge-stable-text);
      border-color: var(--badge-stable-border);
    }
    .verdict-unverified {
      background: var(--badge-unverified-bg);
      color: var(--badge-unverified-text);
      border-color: var(--badge-unverified-border);
    }

    .metadata-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 16px;
      border-top: 1px solid var(--border-subtle);
      padding-top: 20px;
    }
    .metadata-item {
      display: flex;
      flex-direction: column;
    }
    .metadata-label {
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 4px;
    }
    .metadata-value {
      font-size: 15px;
      font-weight: 600;
      color: var(--text-main);
    }

    /* Summary Strip */
    .summary-strip {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 12px;
      padding: 20px 24px;
      margin-bottom: 24px;
    }
    .stat-tiles {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 12px;
      margin-bottom: 12px;
    }
    .stat-tile {
      background: var(--bg-page);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 12px;
      text-align: center;
    }
    .stat-count {
      font-size: 22px;
      font-weight: 700;
      margin-bottom: 2px;
    }
    .stat-tile.action .stat-count { color: #dc2626; }
    .stat-tile.review .stat-count { color: #d97706; }
    .stat-tile.minor .stat-count { color: #2563eb; }
    .stat-tile.stable .stat-count { color: #16a34a; }
    .stat-tile.unverified .stat-count { color: #64748b; }
    .stat-name {
      font-size: 12px;
      font-weight: 500;
      color: var(--text-muted);
    }
    .summary-narrative {
      font-size: 14px;
      color: var(--text-muted);
      font-weight: 500;
    }

    /* Section Headers */
    .section-title {
      font-size: 18px;
      font-weight: 700;
      margin: 28px 0 16px 0;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* Cards */
    .card-item {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 10px;
      padding: 20px;
      margin-bottom: 16px;
      box-shadow: 0 1px 2px rgba(0,0,0,0.04);
    }
    .card-header-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 14px;
      flex-wrap: wrap;
      gap: 8px;
    }
    .item-heading {
      font-size: 16px;
      font-weight: 700;
      color: var(--text-main);
    }
    .confidence-chip {
      font-size: 12px;
      font-weight: 600;
      padding: 3px 10px;
      border-radius: 9999px;
      background: var(--bg-page);
      border: 1px solid var(--border-subtle);
      color: var(--text-muted);
    }
    .comparison-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 16px;
    }
    @media (max-width: 640px) {
      .comparison-grid { grid-template-columns: 1fr; }
    }
    .compare-box {
      background: var(--bg-page);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 12px 14px;
    }
    .compare-heading {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 6px;
    }
    .compare-text {
      font-size: 14px;
      word-break: break-word;
      white-space: pre-wrap;
    }

    /* Context & Action Blocks */
    .context-block {
      background: var(--bg-page);
      border-left: 3px solid #2563eb;
      padding: 10px 14px;
      border-radius: 0 6px 6px 0;
      margin-bottom: 10px;
      font-size: 13px;
    }
    .action-block {
      background: var(--bg-page);
      border-left: 3px solid #16a34a;
      padding: 10px 14px;
      border-radius: 0 6px 6px 0;
      font-size: 13px;
    }
    .block-lead {
      font-weight: 700;
      color: var(--text-main);
      margin-bottom: 2px;
    }

    /* Inline Diff */
    .diff-container {
      background: var(--bg-page);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 14px;
      font-size: 14px;
      line-height: 1.6;
      word-break: break-word;
      margin-bottom: 10px;
    }
    .diff-add {
      background-color: var(--diff-add-bg);
      color: var(--diff-add-text);
      text-decoration: none;
      padding: 1px 4px;
      border-radius: 3px;
      font-weight: 600;
    }
    .diff-del {
      background-color: var(--diff-del-bg);
      color: var(--diff-del-text);
      text-decoration: line-through;
      padding: 1px 4px;
      border-radius: 3px;
      opacity: 0.85;
    }
    .diff-stats {
      font-size: 12px;
      color: var(--text-muted);
      font-weight: 500;
    }

    /* Table */
    .table-container {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 10px;
      overflow-x: auto;
      margin-bottom: 24px;
    }
    .record-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
      text-align: left;
    }
    .record-table th {
      background: var(--bg-page);
      padding: 12px 16px;
      font-weight: 600;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border-subtle);
    }
    .record-table td {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border-subtle);
      vertical-align: top;
    }
    .record-table tr:last-child td {
      border-bottom: none;
    }
    .status-chip {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 9999px;
      font-size: 11px;
      font-weight: 600;
    }
    .status-chip.needs_attention { background: var(--badge-action-bg); color: var(--badge-action-text); }
    .status-chip.review_recommended { background: var(--badge-review-bg); color: var(--badge-review-text); }
    .status-chip.minor_change { background: #dbeafe; color: #1e40af; }
    .status-chip.unchanged { background: var(--badge-stable-bg); color: var(--badge-stable-text); }
    .status-chip.could_not_verify { background: var(--badge-unverified-bg); color: var(--badge-unverified-text); }

    /* Audit Section (Technical details enclosed safely) */
    .audit-details {
      margin-top: 32px;
      border-top: 1px dashed var(--border-subtle);
      padding-top: 16px;
      font-size: 12px;
      color: var(--text-muted);
    }
    .audit-details summary {
      cursor: pointer;
      font-weight: 600;
      padding: 6px 0;
      user-select: none;
    }
    .audit-box {
      margin-top: 12px;
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: 8px;
      padding: 16px;
      font-family: monospace;
      font-size: 11px;
      word-break: break-all;
    }

    /* Print Styles */
    @media print {
      body {
        background: #ffffff !important;
        color: #000000 !important;
        padding: 0 !important;
        font-size: 10pt;
      }
      .header-card, .summary-strip, .card-item, .table-container {
        border: 1px solid #ccc !important;
        box-shadow: none !important;
        break-inside: avoid;
        page-break-inside: avoid;
      }
      .priority-badge, .status-chip, .diff-add, .diff-del {
        border: 1px solid #999 !important;
      }
    }
  </style>
</head>
<body>
  <div class="report-wrapper">

    <!-- Section 1: Header + Verdict Badge -->
    <header class="header-card">
      <div class="header-top">
        <div>
          <h1 class="company-title">${escapeHtml(r.company)}</h1>
          <p class="company-meta">${escapeHtml(r.domain)}</p>
        </div>
        <div class="priority-badge ${verdictConfig.class}">
          ${escapeHtml(verdictConfig.badge)}
        </div>
      </div>
      <div class="metadata-grid">
        <div class="metadata-item">
          <span class="metadata-label">Today's Check</span>
          <span class="metadata-value">${escapeHtml(formattedScannedDate)}</span>
        </div>
        <div class="metadata-item">
          <span class="metadata-label">Previous Record</span>
          <span class="metadata-value">${escapeHtml(formattedPriorDate)}</span>
        </div>
        <div class="metadata-item">
          <span class="metadata-label">Record Age</span>
          <span class="metadata-value">${escapeHtml(priorAgeDays)}</span>
        </div>
        <div class="metadata-item">
          <span class="metadata-label">Verdict Summary</span>
          <span class="metadata-value" style="font-size: 13px; font-weight: normal;">${escapeHtml(verdictConfig.summary)}</span>
        </div>
      </div>
    </header>

    <!-- Section 2: Summary Strip of Counts -->
    <section class="summary-strip">
      <div class="stat-tiles">
        <div class="stat-tile action">
          <div class="stat-count">${r.counts.needs_attention}</div>
          <div class="stat-name">Action Needed</div>
        </div>
        <div class="stat-tile review">
          <div class="stat-count">${r.counts.review_recommended}</div>
          <div class="stat-name">Review Needed</div>
        </div>
        <div class="stat-tile minor">
          <div class="stat-count">${r.counts.minor}</div>
          <div class="stat-name">Minor Updates</div>
        </div>
        <div class="stat-tile unverified">
          <div class="stat-count">${r.counts.could_not_verify}</div>
          <div class="stat-name">Unverified</div>
        </div>
        <div class="stat-tile stable">
          <div class="stat-count">${r.counts.unchanged}</div>
          <div class="stat-name">Unchanged</div>
        </div>
      </div>
      <p class="summary-narrative">${escapeHtml(countNarrative)}</p>
    </section>

    <!-- Section 3: Needs Attention Cards (Before | After Side by Side) -->
    ${r.needs_attention && r.needs_attention.length > 0 ? `
    <section>
      <h2 class="section-title">Critical Attention Items</h2>
      ${r.needs_attention.map(item => `
      <div class="card-item">
        <div class="card-header-row">
          <span class="item-heading">${escapeHtml(item.label)}</span>
          <span class="confidence-chip">${escapeHtml(item.confidence_label)}</span>
        </div>
        <div class="comparison-grid">
          <div class="compare-box">
            <div class="compare-heading">Previous Record</div>
            <div class="compare-text">${escapeHtml(item.before)}</div>
          </div>
          <div class="compare-box">
            <div class="compare-heading">Today's Check</div>
            <div class="compare-text">${escapeHtml(item.after)}</div>
          </div>
        </div>
        <div class="context-block">
          <div class="block-lead">Why it matters</div>
          <div>${escapeHtml(item.why_it_matters)}</div>
        </div>
        <div class="action-block">
          <div class="block-lead">Recommended action</div>
          <div>${escapeHtml(item.recommended_action)}</div>
        </div>
      </div>
      `).join('')}
    </section>
    ` : ''}

    <!-- Section 4: Review Recommended Cards (Pending Confirmation) -->
    ${r.review_recommended && r.review_recommended.length > 0 ? `
    <section>
      <h2 class="section-title">Review Recommended Items</h2>
      ${r.review_recommended.map(item => `
      <div class="card-item">
        <div class="card-header-row">
          <span class="item-heading">${escapeHtml(item.label)}</span>
          <span class="confidence-chip">${escapeHtml(item.confidence_label)}</span>
        </div>
        <div class="comparison-grid">
          <div class="compare-box">
            <div class="compare-heading">Previous Record</div>
            <div class="compare-text">${escapeHtml(item.before)}</div>
          </div>
          <div class="compare-box">
            <div class="compare-heading">Today's Check</div>
            <div class="compare-text">${escapeHtml(item.after)}</div>
          </div>
        </div>
        <div class="context-block">
          <div class="block-lead">Why it matters</div>
          <div>${escapeHtml(item.why_it_matters)}</div>
        </div>
        <div class="action-block">
          <div class="block-lead">Recommended action</div>
          <div>${escapeHtml(item.recommended_action)}</div>
        </div>
      </div>
      `).join('')}
    </section>
    ` : ''}

    <!-- Section 5: Minor Changes with Inline Diffs -->
    ${r.minor_changes && r.minor_changes.length > 0 ? `
    <section>
      <h2 class="section-title">Minor Updates &amp; Formatting Adjustments</h2>
      ${r.minor_changes.map(item => `
      <div class="card-item">
        <div class="card-header-row">
          <span class="item-heading">${escapeHtml(item.label)}</span>
          <span class="confidence-chip">${escapeHtml(item.reason_label || 'Minor wording adjustment')}</span>
        </div>
        <div class="diff-container">
          ${renderInlineDiffHtml(item.diff)}
        </div>
        <div class="diff-stats">
          +${item.diff ? item.diff.words_added : 0} words added, -${item.diff ? item.diff.words_removed : 0} words removed (${item.diff ? item.diff.similarity_pct : 100}% text match)
        </div>
      </div>
      `).join('')}
    </section>
    ` : ''}

    <!-- Section 6: Could Not Verify -->
    ${r.could_not_verify && r.could_not_verify.length > 0 ? `
    <section>
      <h2 class="section-title">Unverified In Latest Check</h2>
      ${r.could_not_verify.map(item => `
      <div class="card-item">
        <div class="card-header-row">
          <span class="item-heading">${escapeHtml(item.label)}</span>
          <span class="confidence-chip">Unverified</span>
        </div>
        <div class="compare-box" style="margin-bottom: 10px;">
          <div class="compare-heading">Previous Record</div>
          <div class="compare-text">${escapeHtml(item.before)}</div>
        </div>
        <p style="font-size: 13px; color: var(--text-muted);">${escapeHtml(item.description)}</p>
      </div>
      `).join('')}
    </section>
    ` : ''}

    <!-- Section 7: Detail Table (All Details with Status Chips) -->
    <section>
      <h2 class="section-title">Complete Record Overview</h2>
      <div class="table-container">
        <table class="record-table">
          <thead>
            <tr>
              <th>Detail</th>
              <th>Previous Record</th>
              <th>Today's Check</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${r.field_table && r.field_table.length > 0 ? r.field_table.map(row => `
            <tr>
              <td style="font-weight: 600;">${escapeHtml(row.label)}</td>
              <td>${escapeHtml(row.before)}</td>
              <td>${escapeHtml(row.after)}</td>
              <td><span class="status-chip ${row.status}">${escapeHtml(row.status_label)}</span></td>
            </tr>
            `).join('') : `
            <tr>
              <td colspan="4" style="text-align: center; color: var(--text-muted);">No items recorded</td>
            </tr>
            `}
          </tbody>
        </table>
      </div>
    </section>

    <!-- Section 8: Technical Audit Section (Enclosed in Details) -->
    <details class="audit-details">
      <summary>Technical audit details</summary>
      <div class="audit-box">
        <p><strong>Comparator Engine Version:</strong> ${escapeHtml(r.audit ? r.audit.comparator_version : '2.0.0')}</p>
        <p><strong>Baseline Quality Metric:</strong> ${escapeHtml(r.baseline_quality)}</p>
        <p><strong>Baseline Age:</strong> ${escapeHtml(priorAgeDays)}</p>
        <p><strong>Prior SHA256 Fingerprint:</strong> ${escapeHtml(r.audit ? r.audit.old_sha256 : '—')}</p>
        <p><strong>Live Check SHA256 Fingerprint:</strong> ${escapeHtml(r.audit ? r.audit.new_sha256 : '—')}</p>
        <p><strong>Registered Change Identifiers:</strong> ${r.audit && r.audit.change_ids && r.audit.change_ids.length > 0 ? escapeHtml(r.audit.change_ids.join(', ')) : 'none'}</p>
      </div>
    </details>

  </div>
</body>
</html>`;
}

function saveJsonReport(report, outDir = 'results') {
  const dir = path.resolve(process.cwd(), outDir);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const filename = `${report.domain || 'company'}_report.json`;
  const fullPath = path.join(dir, filename);
  fs.writeFileSync(fullPath, JSON.stringify(report, null, 2), 'utf8');
  return fullPath;
}

module.exports = {
  buildReport,
  saveJsonReport,
  renderReportHtml,
  computeWordDiff,
  formatReportDate,
  sanitizeEvidence,
  escapeHtml
};

