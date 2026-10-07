/**
 * Client-Friendly Report Builder (src/reporting/client_report.js)
 * -----------------------------------------------------------------
 * Generates clean, executive business-level output WITHOUT exposing internal technical jargon:
 * - NO cosine distances
 * - NO Jaccard intersection/union counts
 * - NO TF-IDF token vectors
 * - NO embedding model hashes
 *
 * Produces plain, actionable English explaining what changed about the company.
 */

function formatFieldLabel(path) {
  const map = {
    'companyName': 'Company Name',
    'company_name': 'Company Name',
    'legalName': 'Legal Name',
    'phone': 'Phone Number',
    'phoneFormatted': 'Phone Number',
    'email': 'Email Address',
    'address': 'Physical Address',
    'country': 'Operating Country',
    'registration_number': 'Company Registration Number',
    'description': 'Company Description',
    'aboutPage': 'About Us Page Content',
    'title': 'Website Title'
  };
  return map[path] || path;
}

function buildClientReport(analysisResult) {
  const company = analysisResult.company || {};
  const fieldEvals = analysisResult.fieldEvaluations || [];
  const overallStatus = analysisResult.summary?.finalAction || 'REVIEW';

  const clientChanges = [];

  for (const item of fieldEvals) {
    if (item.action === 'IGNORE' || item.importance === 'IGNORE') continue;

    const label = formatFieldLabel(item.path);
    let reason = item.reason;

    if (item.comparisonType === 'VALUE_REMOVED') {
      reason = `Previously available ${label.toLowerCase()} is no longer present on the website.`;
    } else if (item.comparisonType === 'VALUE_ADDED') {
      reason = `Newly discovered ${label.toLowerCase()} was published on the website.`;
    }

    clientChanges.push({
      field: label,
      path: item.path,
      previous: item.oldValue,
      current: item.newValue,
      importance: item.importance,
      reason
    });
  }

  let summaryText = 'No significant business changes detected.';
  if (overallStatus === 'REVIEW') {
    summaryText = `Several important company profile attributes changed or were omitted on the latest website crawl.`;
  } else if (overallStatus === 'AUTO_ACCEPT') {
    summaryText = 'Routine content revisions or data enrichments detected. No critical business disruptions found.';
  }

  return {
    company: company.company_name,
    domain: company.domain,
    overallStatus,
    summary: summaryText,
    totalChanges: clientChanges.length,
    changes: clientChanges
  };
}

module.exports = {
  buildClientReport,
  formatFieldLabel
};

