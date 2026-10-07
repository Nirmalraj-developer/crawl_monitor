#!/usr/bin/env node
/**
 * Batch DB Pipeline Runner (batch_run_signals.js)
 * ------------------------------------------------
 * Fetches company baseline from PostgreSQL database,
 * runs fresh live crawl via Crawler API,
 * executes the field-aware 6-signal change analysis pipeline,
 * and saves both developer and client-friendly JSON reports.
 *
 * Usage:
 *   node batch_run_signals.js
 *   node batch_run_signals.js domain1.com domain2.com
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { crawlDomain, cleanDomain } = require('./crawler_service');
const { analyzeCompanyChanges } = require('./src');

// Load environment variables
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

async function fetchCompanyFromDb(client, domain) {
  const normDomain = cleanDomain(domain);

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

function mapDbRecordToCrawlJson(profile, contentStaging, domain) {
  const normDomain = profile?.normalized_domain || profile?.domain_name || domain;
  return {
    status: 1,
    message: 'Baseline extracted from PostgreSQL.',
    totalCount: 1,
    data: [
      {
        processingId: normDomain,
        url: profile?.website || `https://${normDomain}/`,
        normalizedDomain: normDomain,
        redirection: 'false',
        hostIp: profile?.host_ip ? String(profile.host_ip) : null,
        ipCountry: profile?.country || null,
        loadTimeMs: profile?.load_time_ms || null,
        responseCode: profile?.response_code ? String(profile.response_code) : '200',
        domainStatus: 'Valid',
        comments: 'valid',
        webServer: profile?.web_server || null,
        homeContent: contentStaging?.content || null,
        title: profile?.title || null,
        description: profile?.description || profile?.summary || null,
        language: profile?.language || null,
        companyName: profile?.company_name || null,
        name: profile?.company_name || null,
        phone: profile?.phone || null,
        email: profile?.email || null,
        address: profile?.address || null,
        country: profile?.country || null,
        registration_number: profile?.registration_number || null,
        homeLinks: profile?.home_alllinks || null,
        aboutLinksAll: profile?.about_alllinks || null,
        contactLinksAll: profile?.contact_alllinks || null,
        aboutPage: contentStaging?.about_content || null,
        contactPage: contentStaging?.contact_content || null
      }
    ]
  };
}

async function runPipelineForDomains(domains) {
  console.log('\n========================================================================================');
  console.log(` BATCH DATABASE & LIVE CRAWL ANALYSIS: ${domains.length} COMPANIES`);
  console.log('========================================================================================');

  const dbClient = createDbClient();
  await dbClient.connect();

  const summaryResults = [];

  for (let i = 0; i < domains.length; i++) {
    const domain = domains[i];
    console.log(`\n[${i + 1}/${domains.length}] Processing: ${domain}`);
    console.log('----------------------------------------------------------------------------------------');

    try {
      // 1. Fetch DB Baseline
      console.log(` • Fetching baseline from PostgreSQL...`);
      const { profile, content } = await fetchCompanyFromDb(dbClient, domain);
      if (!profile) {
        console.warn(`   ⚠️ Warning: No baseline found in DB for ${domain}, skipping.`);
        continue;
      }
      const baselineJson = mapDbRecordToCrawlJson(profile, content, domain);

      // Save baseline to data/old
      const oldDir = path.resolve(process.cwd(), 'data', 'old');
      if (!fs.existsSync(oldDir)) fs.mkdirSync(oldDir, { recursive: true });
      fs.writeFileSync(path.join(oldDir, `${domain}.json`), JSON.stringify(baselineJson, null, 2), 'utf8');

      // 2. Fetch Live Crawl
      console.log(` • Requesting fresh live crawl via Crawler API...`);
      const liveCrawlJson = await crawlDomain(domain, { timeoutMs: 45000 });

      // Save live crawl to data/new
      const newDir = path.resolve(process.cwd(), 'data', 'new');
      if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });
      fs.writeFileSync(path.join(newDir, `${domain}.json`), JSON.stringify(liveCrawlJson, null, 2), 'utf8');

      // 3. Run Field-Aware Six-Signal Change Analyzer
      console.log(` • Running 6-signal change analysis...`);
      const analysis = await analyzeCompanyChanges(baselineJson, liveCrawlJson);
      const rep = analysis.clientReport;

      console.log(`\n   ✓ Results for ${domain}:`);
      console.log(`     - Company:         ${rep.company}`);
      console.log(`     - Overall Status:  [${rep.overallStatus}]`);
      console.log(`     - Changes Count:   ${rep.totalChanges}`);
      console.log(`     - Summary:         ${rep.summary}`);
      console.log(`     - Client Report:   ${analysis._clientReportPath}`);
      console.log(`     - Developer Audit: ${analysis._filePath}`);

      summaryResults.push({
        domain,
        company: rep.company,
        status: rep.overallStatus,
        changesCount: rep.totalChanges,
        clientReportPath: analysis._clientReportPath,
        developerReportPath: analysis._filePath
      });

    } catch (err) {
      console.error(`   ❌ Error processing ${domain}:`, err.message);
    }
  }

  await dbClient.end();

  // Save consolidated batch summary
  const resultsDir = path.resolve(process.cwd(), 'results');
  const batchSummaryPath = path.join(resultsDir, 'batch_5_companies_summary.json');
  fs.writeFileSync(batchSummaryPath, JSON.stringify(summaryResults, null, 2), 'utf8');

  console.log('\n========================================================================================');
  console.log(` BATCH EXECUTION COMPLETE`);
  console.log(` Consolidated Summary Saved: ${batchSummaryPath}`);
  console.log('========================================================================================\n');
}

const targetDomains = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : ['infynd.com', 'whitestudiolondon.com', 'twelvesix.co', 'sanctuarycottages.net', 'sircloud.net'];

runPipelineForDomains(targetDomains).catch(err => {
  console.error('Batch Execution Failed:', err);
  process.exit(1);
});

