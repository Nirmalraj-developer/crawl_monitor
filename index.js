#!/usr/bin/env node
/**
 * Main Pipeline Orchestrator (index.js)
 * -------------------------------------
 * Coordinates the clean 4-part flow:
 *   1. Crawler Service   (crawler_service.js)
 *   2. JSON Storage      (json_storage.js)
 *   3. Comparator Engine (comparator.js)
 *   4. AI Verifier       (ai_verifier.js) - Checks: Is it an original change or marketing fluff?
 *
 * Flow:
 *   - Crawls domain.
 *   - Checks if previous crawl is available in JSON storage.
 *   - If FIRST TIME: Stores as baseline snapshot.
 *   - If ALREADY EXISTS:
 *       1. Compares old JSON vs new crawl based on business conditions.
 *       2. If changes found: Runs AI Verification to confirm if it is an ORIGINAL change or fluff.
 *       3. Saves report and archives history.
 */

const path = require('path');
const { crawlDomain, cleanDomain } = require('./crawler_service');
const {
  hasPreviousCrawl,
  getLatestCrawl,
  saveCrawlSnapshot,
  saveComparisonResult,
} = require('./json_storage');
const { compareCrawls } = require('./comparator');
const { verifyChangesWithAI } = require('./ai_verifier');

async function processCompany(domain, options = {}) {
  const targetDomain = cleanDomain(domain);
  if (!targetDomain) {
    throw new Error('Please specify a valid company domain (e.g. infynd.com).');
  }

  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  Company Crawl & Change Detection Pipeline: [ ${targetDomain} ]`);
  console.log('═══════════════════════════════════════════════════════════════');

  // Step 1: Check if this company was previously crawled
  const existsBefore = hasPreviousCrawl(targetDomain);
  console.log(`[Storage Check] Previous crawl available in JSON storage: ${existsBefore ? 'YES (Will Compare)' : 'NO (First Crawl Baseline)'}`);

  let previousSnapshot = null;
  if (existsBefore) {
    previousSnapshot = getLatestCrawl(targetDomain);
    console.log(`[Storage Check] Loaded previous snapshot saved on: ${previousSnapshot?.saved_at || 'N/A'}`);
  }

  // Step 2: Execute fresh crawl
  console.log(`[Crawl Step] Fetching fresh crawl for ${targetDomain}...`);
  let newCrawlData = null;

  try {
    newCrawlData = await crawlDomain(targetDomain, options);
  } catch (crawlErr) {
    // If running in an offline or sandboxed environment, check if a local fallback crawl file exists
    const fallbackPath = path.resolve(process.cwd(), 'crawler_response.json');
    const fs = require('fs');
    if (fs.existsSync(fallbackPath)) {
      console.warn(`[Crawler Warning] Live crawl failed (${crawlErr.message}). Using local crawler_response.json as fresh crawl.`);
      newCrawlData = JSON.parse(fs.readFileSync(fallbackPath, 'utf8'));
    } else {
      throw crawlErr;
    }
  }

  // Step 3: Handle First Crawl vs Re-Crawl Comparison
  if (!existsBefore) {
    // First time crawling this company
    console.log(`\n[Action] First crawl detected. Saving as initial baseline snapshot...`);
    const savedPath = saveCrawlSnapshot(targetDomain, newCrawlData);

    const initialReport = {
      domain: targetDomain,
      status: 'INITIAL_BASELINE_STORED',
      message: `Initial baseline crawl stored successfully in ${path.relative(process.cwd(), savedPath)}. Re-running this command will compare future crawls against this baseline.`,
      stored_at: new Date().toISOString(),
    };

    console.log('\n--- Pipeline Result ---');
    console.log(JSON.stringify(initialReport, null, 2));
    return initialReport;
  }

  // Step 4: Existing company re-crawled -> Run Comparator
  console.log(`\n[Action] Existing company found in storage. Running Comparator...`);
  const comparisonResult = compareCrawls(previousSnapshot, newCrawlData);

  // Step 5: If differences suspected, ask AI: Is it an ORIGINAL change or marketing fluff?
  let aiVerification = null;
  if (comparisonResult.has_meaningful_change) {
    console.log(`\n[AI Verification] Suspected changes detected by comparator.`);
    console.log(`[AI Verification] Asking AI: Is this an ORIGINAL change or superficial marketing fluff?`);
    aiVerification = await verifyChangesWithAI(previousSnapshot, newCrawlData, comparisonResult.changes);
  }

  const finalReport = {
    ...comparisonResult,
    ai_verification: aiVerification,
  };

  // Step 6: Save Comparison Report
  const reportPath = saveComparisonResult(targetDomain, finalReport);

  // Step 7: Update baseline if AI confirms genuine change
  if (aiVerification && aiVerification.is_original_change) {
    console.log(`\n[Action] AI Confirmed: ORIGINAL BUSINESS CHANGE! Updating baseline snapshot (archiving previous in data/history)...`);
    saveCrawlSnapshot(targetDomain, newCrawlData);
  } else if (comparisonResult.has_meaningful_change && aiVerification && !aiVerification.is_original_change) {
    console.log(`\n[Action] AI Verdict: REJECTED as marketing fluff. Stored baseline snapshot preserved.`);
  }

  console.log('\n--- Final Verification Result ---');
  console.log(JSON.stringify(finalReport, null, 2));

  return finalReport;
}

// Direct CLI Execution: node index.js <domain>
if (require.main === module) {
  const targetDomain = process.argv[2] || 'infynd.com';

  processCompany(targetDomain)
    .catch((err) => {
      console.error('\n[Pipeline Failure]:', err.message);
      process.exit(1);
    });
}

module.exports = {
  processCompany,
};
