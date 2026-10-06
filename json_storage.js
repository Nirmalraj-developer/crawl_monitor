/**
 * JSON Storage Manager (json_storage.js)
 * --------------------------------------
 * Responsibility: Manages persistence, retrieval, and historical archiving
 * of company crawl JSON files on disk.
 */

const fs = require('fs');
const path = require('path');

const STORAGE_ROOT = path.resolve(__dirname, 'data');
const SNAPSHOTS_DIR = path.join(STORAGE_ROOT, 'snapshots');
const HISTORY_DIR = path.join(STORAGE_ROOT, 'history');
const CHANGES_DIR = path.join(STORAGE_ROOT, 'changes');

// Ensure all storage directories exist
function ensureDirs() {
  for (const dir of [STORAGE_ROOT, SNAPSHOTS_DIR, HISTORY_DIR, CHANGES_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
ensureDirs();

/**
 * Normalizes domain for filename safety (e.g., "infynd.com" -> "infynd.com.json")
 */
function getSnapshotPath(domain) {
  const clean = String(domain).trim().toLowerCase().replace(/[^a-z0-9.-]/g, '_');
  return path.join(SNAPSHOTS_DIR, `${clean}.json`);
}

/**
 * Checks whether a previous crawl JSON exists and is non-empty for this domain.
 * @param {string} domain - Target company domain
 * @returns {boolean}
 */
function hasPreviousCrawl(domain) {
  const filePath = getSnapshotPath(domain);
  if (!fs.existsSync(filePath)) return false;
  try {
    const stat = fs.statSync(filePath);
    return stat.size > 2; // more than just "{}" or empty
  } catch (_) {
    return false;
  }
}

/**
 * Loads the latest stored crawl JSON for the domain.
 * @param {string} domain - Target company domain
 * @returns {object|null}
 */
function getLatestCrawl(domain) {
  const filePath = getSnapshotPath(domain);
  if (!hasPreviousCrawl(domain)) return null;

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[JSONStorage Error] Failed to read ${filePath}:`, err.message);
    return null;
  }
}

/**
 * Saves a new crawl snapshot as the current baseline.
 * If a previous snapshot exists, archives it into data/history with a timestamp.
 * @param {string} domain - Target company domain
 * @param {object} crawlData - The crawl JSON payload to store
 * @returns {string} The path where the snapshot was saved
 */
function saveCrawlSnapshot(domain, crawlData) {
  ensureDirs();
  const currentPath = getSnapshotPath(domain);

  // If a previous crawl exists, archive it into history before overwriting
  if (fs.existsSync(currentPath)) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const clean = String(domain).trim().toLowerCase().replace(/[^a-z0-9.-]/g, '_');
      const archivePath = path.join(HISTORY_DIR, `${clean}_${timestamp}.json`);
      fs.copyFileSync(currentPath, archivePath);
      console.log(`[JSONStorage] Previous crawl archived to: ${path.relative(process.cwd(), archivePath)}`);
    } catch (archiveErr) {
      console.warn(`[JSONStorage Warning] Could not archive previous snapshot: ${archiveErr.message}`);
    }
  }

  // Save the latest snapshot
  const payloadToStore = {
    domain,
    saved_at: new Date().toISOString(),
    crawl_data: crawlData,
  };

  fs.writeFileSync(currentPath, JSON.stringify(payloadToStore, null, 2), 'utf8');
  console.log(`[JSONStorage] Latest crawl snapshot saved to: ${path.relative(process.cwd(), currentPath)}`);
  return currentPath;
}

/**
 * Saves a change detection / comparison result to the changes directory.
 * @param {string} domain - Target company domain
 * @param {object} comparisonResult - The structured comparison output
 * @returns {string} The path where the comparison was saved
 */
function saveComparisonResult(domain, comparisonResult) {
  ensureDirs();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const clean = String(domain).trim().toLowerCase().replace(/[^a-z0-9.-]/g, '_');
  const resultPath = path.join(CHANGES_DIR, `${clean}_diff_${timestamp}.json`);

  fs.writeFileSync(resultPath, JSON.stringify(comparisonResult, null, 2), 'utf8');
  console.log(`[JSONStorage] Comparison report saved to: ${path.relative(process.cwd(), resultPath)}`);
  return resultPath;
}

/**
 * Lists all stored company domains currently in storage.
 * @returns {string[]}
 */
function listStoredDomains() {
  ensureDirs();
  const files = fs.readdirSync(SNAPSHOTS_DIR);
  return files
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''));
}

module.exports = {
  hasPreviousCrawl,
  getLatestCrawl,
  saveCrawlSnapshot,
  saveComparisonResult,
  listStoredDomains,
  getSnapshotPath,
  SNAPSHOTS_DIR,
  HISTORY_DIR,
  CHANGES_DIR,
};

