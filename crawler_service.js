/**
 * Crawler Service (crawler_service.js)
 * -----------------------------------
 * Responsibility: Connects to the Crawler API and fetches company crawl data.
 * Endpoint: POST http://173.249.56.10:8000/api/v1/crawler/extract-company-info
 * Payload: { "domains": ["<domain>"] }
 */

const fs = require('fs');
const path = require('path');

// Load environment variables if .env exists
function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [k, ...v] = trimmed.split('=');
    if (!process.env[k.trim()]) {
      process.env[k.trim()] = v.join('=').trim().replace(/^['"]|['"]$/g, '');
    }
  }
}
loadEnv();

const DEFAULT_CRAWLER_URL = 'http://173.249.56.10:8000/api/v1/crawler/extract-company-info';
const CRAWLER_URL = process.env.CRAWLER_WEBSITE_URL || process.env.CRAWLER_EXTRACT_URL || DEFAULT_CRAWLER_URL;

/**
 * Normalizes any URL string into a clean domain name.
 * e.g., "https://www.infynd.com/about" -> "infynd.com"
 */
function cleanDomain(targetUrl) {
  if (!targetUrl || typeof targetUrl !== 'string') return '';
  let clean = targetUrl.trim().toLowerCase();
  clean = clean.replace(/^(https?:\/\/)/i, '');
  clean = clean.replace(/^www\./i, '');
  clean = clean.split('/')[0].split(':')[0];
  return clean;
}

/**
 * Calls Crawler API to extract company information.
 * @param {string} domain - Target company domain or URL
 * @param {object} [options] - Optional custom configs (url, timeoutMs)
 * @returns {Promise<object>} The raw crawler response JSON
 */
async function crawlDomain(domain, options = {}) {
  const normalized = cleanDomain(domain);
  if (!normalized) {
    throw new Error(`Invalid domain provided to crawler: "${domain}"`);
  }

  const endpoint = options.url || CRAWLER_URL;
  const timeoutMs = options.timeoutMs || 120000;
  const payload = { domains: [normalized] };

  console.log(`[CrawlerService] Requesting crawl for: ${normalized}`);
  console.log(`[CrawlerService] Endpoint: ${endpoint}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Crawler API failed with HTTP ${response.status} (${response.statusText}): ${errText}`);
    }

    const data = await response.json();
    console.log(`[CrawlerService] Successfully received crawl data for ${normalized}`);
    return data;
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`Crawler API request timed out after ${timeoutMs}ms for ${normalized}`);
    }
    throw err;
  }
}

module.exports = {
  crawlDomain,
  cleanDomain,
  CRAWLER_URL,
};

// Standalone CLI testing: node crawler_service.js infynd.com
if (require.main === module) {
  const target = process.argv[2] || 'infynd.com';
  crawlDomain(target)
    .then((res) => {
      console.log('\n--- Crawler Service Output ---');
      console.log(JSON.stringify(res, null, 2));
    })
    .catch((err) => {
      console.error('\n[CrawlerService Error]:', err.message);
      process.exit(1);
    });
}
