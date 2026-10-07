#!/usr/bin/env node
/**
 * Company Crawl & Change Detection Pipeline (index.js)
 * -----------------------------------------------------
 * Reads domain name(s), fetches stored DB baseline from PostgreSQL,
 * executes fresh live crawl via Crawler API, runs comparator engine,
 * and submits a detailed report JSON for each company.
 *
 * Usage:
 *   node index.js <domain>                   # Compare single domain (e.g. node index.js infynd.com)
 *   node index.js domain1.com domain2.com   # Compare multiple domains
 *   node index.js --file domains.txt        # Compare domains from a file
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { crawlDomain, cleanDomain } = require('./crawler_service');
const { compareCrawls } = require('./comparator');

// Load environment variables from .env
function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return {};
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  const env = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [k, ...v] = trimmed.split('=');
    env[k.trim()] = v.join('=').trim().replace(/^['"]|['"]$/g, '');
  }
  return env;
}

const env = loadEnv();

/**
 * Creates a PostgreSQL client configured for read-only baseline queries
 */
function createDbClient() {
  return new Client({
    host: env.GLOBAL_POSTGRESS_HOST || '141.95.66.37',
    port: parseInt(env.GLOBAL_POSTGRESS_PORT || '5432', 10),
    database: env.GLOBAL_POSTGRESS_DATABASE || 'data_engine',
    user: env.GLOBAL_POSTGRESS_USERNAME || 'postgres',
    password: env.GLOBAL_POSTGRESS_PASSWORD || 'hiSYr@uG4TrNzMhfKvX6bP',
    connectionTimeoutMillis: 10000,
    statement_timeout: 10000,
  });
}

/**
 * Fast indexed lookup of company profile and content from PostgreSQL
 * (Strictly read-only SELECT queries)
 */
async function fetchCompanyFromDb(client, domain) {
  const normDomain = cleanDomain(domain);

  // 1. Fetch profile metadata from public.company_profile_global
  const profileRes = await client.query(
    `SELECT 
       domain_name, normalized_domain, company_name, legal_name, tagline, website,
       logo, title, description, summary, "language", country, state, city,
       address, postal_code, phone, email, registration_number,
       about_link, contact_link, privacy_link, terms_link,
       home_alllinks, about_alllinks, contact_alllinks, privacy_alllinks, terms_alllinks,
       response_code, load_time_ms, host_ip, web_server,
       linkedin_url, facebook_url, twitter_url, instagram_url, youtube_url, github_url
     FROM public.company_profile_global
     WHERE domain_name = $1
     LIMIT 1`,
    [normDomain]
  );

  // 2. Fetch content staging from public.domain_content_staging
  const contentRes = await client.query(
    `SELECT 
       domain_name, "content", about_content, contact_content, privacy_content, terms_content
     FROM public.domain_content_staging
     WHERE domain_name = $1
     LIMIT 1`,
    [normDomain]
  );

  const profile = profileRes.rows[0] || null;
  const content = contentRes.rows[0] || {};

  return { profile, content };
}

/**
 * Maps PostgreSQL columns to standard crawler snapshot JSON envelope
 */
function mapDbRecordToCrawlJson(profile, contentStaging, domain) {
  const normDomain = profile.normalized_domain || profile.domain_name || domain;
  return {
    status: 1,
    message: 'Company information extracted from DB baseline.',
    totalCount: 1,
    data: [
      {
        processingId: normDomain,
        url: profile.website || `https://${normDomain}/`,
        normalizedDomain: normDomain,
        redirection: 'false',
        hostIp: profile.host_ip ? String(profile.host_ip) : null,
        ipCountry: profile.country || null,
        loadTimeMs: profile.load_time_ms || null,
        responseCode: profile.response_code ? String(profile.response_code) : '200',
        domainStatus: 'Valid',
        comments: 'valid',
        webServer: profile.web_server || null,
        homeContent: contentStaging.content || null,
        title: profile.title || null,
        description: profile.description || profile.summary || null,
        language: profile.language || null,
        companyName: profile.company_name || null,
        name: profile.company_name || null,
        nameFromTitle: profile.title || null,
        nameFromCopyright: profile.legal_name || null,
        clearbitName: profile.company_name || null,
        email: profile.email || null,
        genericEmail: profile.email || null,
        nonGenericEmail: null,
        phone: profile.phone || null,
        phoneFormatted: profile.phone || null,
        fax: null,
        faxFormatted: null,
        imageUrl: profile.logo || null,
        socialLinks: {
          linkedin: profile.linkedin_url || null,
          facebook: profile.facebook_url || null,
          twitter: profile.twitter_url || null,
          instagram: profile.instagram_url || null,
          youtube: profile.youtube_url || null,
          github: profile.github_url || null,
        },
        domainMatchedSocialLinks: {},
        otherLinks: {
          about: profile.about_link || null,
          contactUs: profile.contact_link || null,
          privacy: profile.privacy_link || null,
          terms: profile.terms_link || null,
        },
        contactLinks: profile.contact_link ? [profile.contact_link] : [],
        privacyLinks: profile.privacy_link ? [profile.privacy_link] : [],
        aboutLinks: profile.about_link ? [profile.about_link] : [],
        termsLinks: profile.terms_link ? [profile.terms_link] : [],
        productLinks: [],
        ecommerceLinks: [],
        serviceLinks: [],
        homeLinks: profile.home_alllinks || null,
        contactLinksAll: profile.contact_alllinks || null,
        privacyLinksAll: profile.privacy_alllinks || null,
        aboutLinksAll: profile.about_alllinks || null,
        termsLinksAll: profile.terms_alllinks || null,
        contactPage: contentStaging.contact_content || null,
        privacyPage: contentStaging.privacy_content || null,
        aboutPage: contentStaging.about_content || null,
        termsPage: contentStaging.terms_content || null,
        productPage: null,
        registration_number: profile.registration_number || null,
        address: profile.address || null,
        postal_code: profile.postal_code || null,
      },
    ],
  };
}

/**
 * Writes JSON file atomically using a temporary file
 */
function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.json`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Processes a single company domain:
 * 1. Fetches DB baseline from PostgreSQL
 * 2. Fetches fresh live crawl via Crawler API
 * 3. Compares DB baseline vs live crawl with comparator.js
 * 4. Submits individual report JSON to results/<domain>_report.json
 */
async function processDomain(domain, dbClient = null) {
  const targetDomain = cleanDomain(domain);
  if (!targetDomain) {
    throw new Error(`Invalid domain name: "${domain}"`);
  }

  console.log('\n================================================================');
  console.log(` Processing Company: ${targetDomain}`);
  console.log('================================================================');

  // Step 1: Fetch DB baseline
  let dbBaselineJson = null;
  let dbProfileSummary = null;

  if (dbClient) {
    try {
      console.log(`[DB] Looking up baseline record for ${targetDomain}...`);
      const { profile, content } = await fetchCompanyFromDb(dbClient, targetDomain);

      if (profile) {
        dbBaselineJson = mapDbRecordToCrawlJson(profile, content, targetDomain);
        dbProfileSummary = {
          found_in_db: true,
          company_name: profile.company_name,
          title: profile.title,
          phone: profile.phone,
          email: profile.email,
          address: profile.address,
          postal_code: profile.postal_code,
          website: profile.website,
          has_content: Boolean(content.content),
          has_contact_page: Boolean(content.contact_content),
          has_privacy_page: Boolean(content.privacy_content),
        };
        console.log(`[DB] Found baseline: "${profile.company_name || targetDomain}" (Content length: ${(content.content || '').length} chars)`);

        // Save DB baseline snapshot locally
        const oldSnapshotPath = path.resolve(process.cwd(), 'data', 'old', `${targetDomain}.json`);
        atomicWriteJson(oldSnapshotPath, dbBaselineJson);
      } else {
        console.warn(`[DB] No matching profile found in public.company_profile_global for ${targetDomain}`);
      }
    } catch (dbErr) {
      console.error(`[DB Warning] Failed to fetch baseline from DB: ${dbErr.message}`);
    }
  }

  // Fallback to local snapshot in data/old if DB lookup was not found
  if (!dbBaselineJson) {
    const localOldPath = path.resolve(process.cwd(), 'data', 'old', `${targetDomain}.json`);
    if (fs.existsSync(localOldPath)) {
      console.log(`[Storage] Loaded existing local baseline snapshot from data/old/${targetDomain}.json`);
      dbBaselineJson = JSON.parse(fs.readFileSync(localOldPath, 'utf8'));
    }
  }

  // Step 2: Fetch fresh live crawl
  console.log(`[Crawler] Fetching live crawl for ${targetDomain}...`);
  let liveCrawlJson = null;
  try {
    liveCrawlJson = await crawlDomain(targetDomain);
    const newSnapshotPath = path.resolve(process.cwd(), 'data', 'new', `${targetDomain}.json`);
    atomicWriteJson(newSnapshotPath, liveCrawlJson);
    console.log(`[Crawler] Live crawl saved to: data/new/${targetDomain}.json`);
  } catch (crawlErr) {
    console.error(`[Crawler Error] Failed to crawl ${targetDomain}: ${crawlErr.message}`);
    const errReport = {
      domain: targetDomain,
      compared_at: new Date().toISOString(),
      status: 'error',
      reason: crawlErr.message,
      has_meaningful_change: false,
      has_pending_confirmation: false,
      summary: `Live crawl failed: ${crawlErr.message}`,
      changes: [],
      noise_detected: [],
      unchanged_fields: [],
      not_found_fields: [],
    };

    const errReportPath = path.resolve(process.cwd(), 'results', `${targetDomain}_report.json`);
    atomicWriteJson(errReportPath, errReport);
    return errReport;
  }

  // If no baseline was found on DB or locally, save fresh crawl as the initial baseline
  if (!dbBaselineJson) {
    console.log(`[Pipeline] First time seeing ${targetDomain}. Saving live crawl as initial baseline.`);
    const baselinePath = path.resolve(process.cwd(), 'data', 'old', `${targetDomain}.json`);
    atomicWriteJson(baselinePath, liveCrawlJson);

    const initialReport = {
      domain: targetDomain,
      compared_at: new Date().toISOString(),
      status: 'INITIAL_BASELINE_STORED',
      has_meaningful_change: false,
      has_pending_confirmation: false,
      summary: `Initial baseline snapshot created for ${targetDomain}. Re-running will compare future crawls against this baseline.`,
      live_crawl_summary: {
        title: liveCrawlJson.data?.[0]?.title || null,
        company_name: liveCrawlJson.data?.[0]?.companyName || liveCrawlJson.data?.[0]?.name || null,
        phone: liveCrawlJson.data?.[0]?.phone || null,
        email: liveCrawlJson.data?.[0]?.email || null,
      },
      changes: [],
      noise_detected: [],
      unchanged_fields: [],
      not_found_fields: [],
    };

    const initialReportPath = path.resolve(process.cwd(), 'results', `${targetDomain}_report.json`);
    atomicWriteJson(initialReportPath, initialReport);
    console.log(`[Output] Initial baseline report saved: results/${targetDomain}_report.json`);
    return initialReport;
  }

  // Step 3: Run Comparator
  console.log(`[Comparator] Comparing DB baseline against live crawl...`);
  const comparisonResult = compareCrawls(dbBaselineJson, liveCrawlJson);

  // Step 4: Assemble comprehensive Company Report
  const liveRec = liveCrawlJson.data?.[0] || {};
  const companyReport = {
    domain: targetDomain,
    compared_at: comparisonResult.compared_at,
    status: comparisonResult.status,
    has_meaningful_change: comparisonResult.has_meaningful_change,
    has_pending_confirmation: comparisonResult.has_pending_confirmation,
    baseline_quality: comparisonResult.baseline_quality,
    coverage: comparisonResult.coverage,
    summary: comparisonResult.summary,
    recommendation: comparisonResult.recommendation || null,
    db_baseline_profile: dbProfileSummary || { found_in_db: false },
    live_crawl_summary: {
      url: liveRec.url || null,
      title: liveRec.title || null,
      company_name: liveRec.companyName || liveRec.name || null,
      phone: liveRec.phone || null,
      email: liveRec.email || null,
      response_code: liveRec.responseCode || null,
      home_content_length: (liveRec.homeContent || '').length,
    },
    changes: comparisonResult.changes,
    baseline_gaps: comparisonResult.baseline_gaps || [],
    noise_detected: comparisonResult.noise_detected || [],
    unchanged_fields: comparisonResult.unchanged_fields || [],
    not_found_fields: comparisonResult.not_found_fields || [],
  };

  // Step 5: Save Individual Report JSON
  const reportPath = path.resolve(process.cwd(), 'results', `${targetDomain}_report.json`);
  atomicWriteJson(reportPath, companyReport);

  // Print neat summary
  console.log('\n--- Company Comparison Summary ---');
  console.log(`Domain:                  ${targetDomain}`);
  console.log(`Status:                  ${companyReport.status.toUpperCase()}`);
  console.log(`Meaningful Change:       ${companyReport.has_meaningful_change ? 'YES [ALERT]' : 'NO'}`);
  console.log(`Pending Confirmation:    ${companyReport.has_pending_confirmation ? 'YES [RE-CRAWL NEEDED]' : 'NO'}`);
  if (companyReport.baseline_quality) {
    console.log(`Baseline Quality:        ${companyReport.baseline_quality.level.toUpperCase()} (Issues: ${companyReport.baseline_quality.issues.join(', ') || 'None'})`);
  }
  if (companyReport.coverage) {
    console.log(`Coverage Ratio:          ${companyReport.coverage.ratio} (${companyReport.coverage.old_links} old vs ${companyReport.coverage.new_links} new links)`);
  }
  console.log(`Changes Detected:        ${companyReport.changes.length}`);
  if (companyReport.changes.length > 0) {
    companyReport.changes.forEach((c) => {
      console.log(`  -> [${c.tier.toUpperCase()}] ${c.field} (${c.change_type}): ${c.description}`);
    });
  }
  if (companyReport.baseline_gaps.length > 0) {
    console.log(`Baseline Gaps:           ${companyReport.baseline_gaps.length} (data missing in DB baseline)`);
  }
  console.log(`Report JSON Saved:       results/${targetDomain}_report.json`);

  return companyReport;
}

/**
 * Main Orchestrator
 */
async function main() {
  const args = process.argv.slice(2);
  // Mode: --accept <domain> (Promotes live crawl to baseline data/old/<domain>.json)
  const acceptIdx = args.indexOf('--accept');
  if (acceptIdx !== -1 && args[acceptIdx + 1]) {
    const targetDomain = cleanDomain(args[acceptIdx + 1].trim());
    console.log(`[Accept] Refreshing baseline for ${targetDomain}...`);
    const newPath = path.resolve(process.cwd(), 'data', 'new', `${targetDomain}.json`);
    const oldPath = path.resolve(process.cwd(), 'data', 'old', `${targetDomain}.json`);

    let newData;
    if (fs.existsSync(newPath)) {
      console.log(`[Accept] Using existing snapshot: data/new/${targetDomain}.json`);
      newData = JSON.parse(fs.readFileSync(newPath, 'utf8'));
    } else {
      console.log(`[Accept] Snapshot not found locally. Crawling ${targetDomain} live...`);
      newData = await crawlDomain(targetDomain);
      atomicWriteJson(newPath, newData);
      console.log(`[Accept] Fresh live crawl saved to: data/new/${targetDomain}.json`);
    }

    atomicWriteJson(oldPath, newData);
    console.log(`[Accept] Baseline successfully updated at: data/old/${targetDomain}.json`);
    console.log(`[Accept] Future runs of 'node index.js ${targetDomain}' will compare against this refreshed baseline.`);
    return;
  }

  // Parse arguments
  const fileIdx = args.indexOf('--file');
  if (fileIdx !== -1 && args[fileIdx + 1]) {
    const filePath = path.resolve(process.cwd(), args[fileIdx + 1]);
    if (fs.existsSync(filePath)) {
      domainsToProcess = fs
        .readFileSync(filePath, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
    } else {
      console.error(`[Error] File not found: ${filePath}`);
      process.exit(1);
    }
  } else {
    // Collect domain arguments (filtering out flags)
    domainsToProcess = args.filter((a) => !a.startsWith('--'));
  }

  // If no domain provided, default to infynd.com with clear instructions
  if (domainsToProcess.length === 0) {
    console.log('No domain provided. Defaulting to: infynd.com');
    console.log('Usage: node index.js <domain> [domain2 ...] [--file domains.txt]\n');
    domainsToProcess = ['infynd.com'];
  }

  console.log(`Starting crawl & comparison pipeline for ${domainsToProcess.length} domain(s)...`);

  // Connect to PostgreSQL
  let dbClient = null;
  try {
    dbClient = createDbClient();
    await dbClient.connect();
    console.log('[DB] Connected to PostgreSQL data_engine successfully.');
  } catch (err) {
    console.warn(`[DB Warning] Could not connect to PostgreSQL (${err.message}). Using local baselines if available.`);
    dbClient = null;
  }

  const reports = [];

  try {
    for (const domain of domainsToProcess) {
      try {
        const rep = await processDomain(domain, dbClient);
        reports.push(rep);
      } catch (err) {
        console.error(`[Error] Failed processing domain "${domain}":`, err.message);
      }
    }
  } finally {
    if (dbClient) {
      await dbClient.end().catch(() => {});
      console.log('\n[DB] Disconnected from PostgreSQL.');
    }
  }

  // If multiple domains were processed, also update comparison_results.json aggregate file
  if (reports.length > 0) {
    const aggregatePath = path.resolve(process.cwd(), 'results', 'comparison_results.json');
    atomicWriteJson(aggregatePath, reports);
    console.log(`\nAll reports saved. Batch summary updated at: results/comparison_results.json`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[Fatal Error]:', err);
    process.exit(1);
  });
}

module.exports = {
  processDomain,
  fetchCompanyFromDb,
  mapDbRecordToCrawlJson,
};

