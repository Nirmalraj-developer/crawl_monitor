# Deep Dive: Architecture & Mechanics of `comparator.js`
> *A neat, step-by-step technical guide to understanding how the comparator engine works internally.*

---

## 1. What is `comparator.js`?

[`comparator.js`](file:///home/nirmal/Nirmal_WorkSpace/Applications/Scripts/Crawl_RND/comparator.js) is a **deterministic, intelligent comparison engine** designed to compare two web crawl snapshots of a business:
- **Baseline Snapshot (`oldJson`):** The historical profile (often stored in PostgreSQL or a previous crawl file).
- **Live Crawl Snapshot (`newJson`):** The fresh data extracted by the crawler service today.

### What it produces
Instead of a simple text diff (like `git diff`), it produces a **business intelligence report** answering:
1. Did a real business event happen? (`has_meaningful_change: true | false`)
2. Is there a change that needs confirmation before sounding alarms? (`has_pending_confirmation: true | false`)
3. Exactly what changed, with what confidence, and what evidence? (`changes: [...]`)
4. What technical noise or formatting quirks were filtered out? (`noise_detected: [...]`)
5. What was missing from the historical database record? (`baseline_gaps: [...]`)

---

## 2. The 11-Stage Pipeline Inside `compareCrawls()`

When `compareCrawls(oldJson, newJson)` is called, the data passes through an 11-stage pipeline:

```
[oldJson + newJson]
        │
        ▼
1. Unwrapping & Normalization (Extract records from nested envelopes)
        │
        ▼
2. Inconclusive Guards (Check HTTP codes, JS blanks, partial crawl drops)
        │
        ▼
3. Redirection Analysis (Detect true rebrands vs apex/www aliases)
        │
        ▼
4. Link Pool & Coverage Guard (Calculate old vs new link ratio)
        │
        ▼
5. Baseline Quality Scoring (Check if DB record has missing pages/meta)
        │
        ▼
6. Symmetrical Raw Link Gathering (Build unified pools for both sides)
        │
        ▼
7. Field-by-Field Diffing (Company Name, Phone, Address, Catalog, etc.)
        │
        ▼
8. Noise Detection (Strip cosmetic legal suffixes, whitespace, etc.)
        │
        ▼
9. Corroboration Engine (Assign alert tiers: alert vs alert_if_confirmed)
        │
        ▼
10. Baseline Gap Safeguards (Cap low-quality changes to log_only)
        │
        ▼
11. Output Assembly & Metrics (Summary, timestamps, unchanged lists)
```

---

## 3. Detailed Walkthrough of Each Stage

### Stage 1: Record Unwrapping & Envelope Parsing
- Crawl snapshots can arrive in different formats:
  - Stored DB format: `{ data: [ { ... } ] }`
  - Live crawler API format: `{ crawl_data: { status: 1, data: [ { ... } ] } }`
  - Direct record: `{ domain: "example.com", ... }`
- The helper `unwrapRecord(json)` extracts the actual company record regardless of which envelope was used.

---

### Stage 2: Inconclusive Guards (Protecting Against False Alarms)
Before diffing any fields, the engine checks if the crawl is valid:
1. **HTTP Status Code Check:** If the new crawl returned `403 Forbidden`, `401 Unauthorized`, `502/503/504 Server Error`, or `429 Rate Limit`, it does **not** assume the site closed. It returns `status: "inconclusive"`.
2. **JavaScript Blank Page Detection:** If `homeContent` shrank by more than 70% (new content length < 30% of old), modern websites often failed JS hydration (e.g. React/Next.js). Returns `status: "inconclusive"`, `reason: "js_rendering_required"`.
3. **Partial Crawl Guard:** If the baseline had 6+ populated fields, but over 50% are null in the new crawl, the crawler had a partial failure. Returns `status: "inconclusive"`, `reason: "partial_crawl"`.

---

### Stage 3: Redirection Intelligence (Apex vs. Real Rebranding)
A naive comparator checks if `url` changed. But almost all websites redirect `http://example.com` to `https://www.example.com/`.
- **How `comparator.js` handles this:**
  - Uses `tldts` to extract the **registrable domain** (e.g. `whitesbodyworks.com`).
  - If `whitesbodyworks.com` redirects to `www.whitesbodyworks.com`, both share the same registrable domain (`whitesbodyworks.com`). **This is NOT a domain redirect!** Normal comparison continues.
  - If `example.com` redirects to `otherbrand.com`, the registrable domain changed. This is a **true rebrand / acquisition** (`tier: alert`, `change_type: domain_redirect`).

---

### Stage 4: Link Pool Coverage Guard
Web crawlers are non-deterministic: on one run they might crawl 40 links, and on a slower network run they might crawl only 18 links.
- The comparator computes:
  $$\text{Coverage Ratio} = \frac{\text{New Unique Links}}{\text{Old Unique Links}}$$
- **The Guard Rule:** If the ratio is **$< 0.5$** (dropped by more than half) or **$> 2.0$** (grew by more than double), catalog and subdomain additions/removals are automatically downgraded to `log_only` with `reason: "coverage_difference"`. This prevents false "catalog reduced" alarms.

---

### Stage 5: Baseline Quality Scoring (`evaluateBaselineQuality`)
Historical database baselines often have missing data. The engine inspects the **Old** snapshot and flags 4 issues:
1. `baseline_pages_missing`: `contactPage`, `privacyPage`, `aboutPage`, or `termsPage` are null in old, but present in new.
2. `baseline_catalog_unclassified`: Old classified arrays (`productLinks`, etc.) are empty, but the old link pool has commercial keywords.
3. `baseline_stale_meta`: Old `title` or `description` does not match the old homepage text.
4. `baseline_different_pipeline`: DB snapshot missing raw crawl metadata.
- **Scoring:** 0 issues = `high`, 1 issue = `medium`, 2+ issues = **`low`**.

---

### Stage 6: Symmetrical Extraction from Raw Link Pools
In old DB records, links were stored in columns like `home_alllinks` or pipe strings. In new crawls, they are in JSON arrays.
- `extractUrls(val)` extracts every link recursively from arrays, bracket strings (`"[a, b]"`), pipe strings (`"a|b"`), and objects.
- `getRawLinkPool(rec)` gathers all raw links into a single pool for both old and new.
- Both sides are processed using the exact same classifier:
  - **Commercial routes:** Contain keywords like `/product/`, `/service/`, `/pricing/`, `/solutions/`.
  - **Content routes:** Contain keywords like `/blog/`, `/news/`, `/article/`.

---

### Stage 7: Route Family Collapsing
When an e-commerce site has pagination (e.g. `/shop-1`, `/shop-2`, `/shop/page/3`), a naive comparator reports 3 new products.
- `getRouteFamily(url)` strips:
  - Pagination numbers: `/page/2`, `/p/5`
  - Numeric suffixes: `/shop-1` $\rightarrow$ `/shop`
  - URL query parameters: `?page=2`, `?p=3`
- A route is only considered "new" if its **family root** is new.

---

### Stage 8: Smart Phone Extraction with Context
Extracting phone numbers from raw HTML is prone to false positives (e.g. mistaking UK Company Registration numbers `12150394` for phones).
- **The Phone Engine (`extractAllPhones`):**
  1. **Region Hint Priority:**
     $$\text{Phone's own }+\text{ prefix} \longrightarrow \text{Address Country} \longrightarrow \text{Postcode Pattern} \longrightarrow \text{Domain TLD} \longrightarrow \text{Language}$$
     *(Never uses `ipCountry`, which only reflects server hosting).*
  2. **Context Requirement:** A number in text is only accepted if it has a `tel:` link, a phone label (`phone`, `tel`, `call`, `t:`, `p:`) within 20 characters before it, or standard `+`/`(0` formatting.
  3. **Blacklist:** Rejects numbers preceded by `company no`, `reg`, `vat`, `id`.
  4. **Registration Number Exclusion:** Any number matching the company registration number is rejected.

---

### Stage 9: Company Name & Brand Intelligence
- **Brand from Title:** Splits titles by delimiters (`|`, `-`, `–`, `—`). Scores each segment by token overlap with the domain name and known brand names.
  - Example: For `whitestudiolondon.com`, `"Wedding dress | White Studio Bridal | UK"` picks `"White Studio Bridal"`, avoiding false "Wedding dress" rebrand drift.
- **Cosmetic Normalization:** Strips legal suffixes (`Inc`, `Ltd`, `LLC`, `GmbH`), whitespace, and punctuation. Changes that are purely legal entity suffixes are logged under `noise_detected`.

---

### Stage 10: Corroboration Engine (Tier Assignment)
How does the comparator decide whether a change is `alert`, `alert_if_confirmed`, or `log_only`?

| Business Change | Corroboration Requirement | Final Tier |
| :--- | :--- | :--- |
| **Physical Office Relocation** | New address seen in contact page + confirmed by Google Maps link | **`alert`** |
| **Physical Office Relocation** | Postcode change alone without map confirmation | **`alert_if_confirmed`** |
| **Phone Number Change** | New number found in 2+ independent sources (e.g. contact page + homepage tel link) | **`alert`** |
| **Phone Number Change** | Number found in 1 source only | **`alert_if_confirmed`** |
| **Company Rebranding** | Name change in title + confirmed by Clearbit name or copyright | **`alert`** |
| **Recruitment ATS Shift** | Career page switches from internal to Lever/Greenhouse/Workable | **`alert_if_confirmed`** |
| **Catalog Expansion** | New commercial products added (coverage balanced) | **`alert_if_confirmed`** |
| **Catalog Expansion** | Coverage ratio imbalanced ($<0.5$ or $>2.0$) | **`log_only`** (`coverage_difference`) |
| **Title / Description Tweak** | Home page content unchanged | **`log_only`** (`baseline_stale_meta`) |

---

### Stage 11: Low Baseline Quality Safeguards & Gap Routing
If Stage 5 found that `baseline_quality.level === 'low'`:
1. Any value extracted from a previously missing page is moved to **`baseline_gaps`** (`tier: log_only`, `change_type: baseline_gap`).
2. All soft content changes (catalog, description, title, subdomains, email, phone) are capped at **`log_only`**.
3. `has_meaningful_change` and `has_pending_confirmation` are forced to **`false`** (unless a hard event like an external redirect, website down, or registration number change occurred).
4. Adds actionable recommendation: `"refresh baseline from a live crawl (--accept)"`.

---

## 4. Key Functions Reference in `comparator.js`

| Function | Purpose |
| :--- | :--- |
| **`compareCrawls(oldJson, newJson, options)`** | Main entrypoint. Performs the 11-stage comparison and returns the final report object. |
| **`extractUrls(val)`** | Recursively extracts, normalizes, and dedupes URLs from strings, pipe-strings, arrays, and objects. |
| **`evaluateBaselineQuality(oldRec, newRec)`** | Computes baseline quality score (`high`, `medium`, `low`) and issue codes. |
| **`getRawLinkPool(rec)`** | Symmetrically gathers all links from all fields into an unclassified raw link list. |
| **`getRouteFamily(urlStr)`** | Normalizes URL paths by stripping numbers, pagination segments, and queries into canonical route families. |
| **`extractAllPhones(rec, domain)`** | Context-aware phone extractor using regional clues and regex validation. |
| **`extractSubdomains(rec, domain)`** | Discovers new business subdomains while filtering out CDNs, assets, and third-party services. |
| **`confirmChanges(firstResult, confResult, liveVsLive)`** | Validates pending changes by checking if they reproduce across live-vs-live crawls. |
| **`evaluateStability(crawl1, crawl2)`** | Detects crawler flakiness by comparing back-to-back live crawls of the same domain. |

---

## 5. Output JSON Schema Explained

Here is what the output JSON looks like with descriptions of each key:

```json
{
  "domain": "infynd.com",
  "compared_at": "2026-10-06T13:44:12.000Z",
  "status": "ok",                       // "ok", "inconclusive", or "error"
  "has_meaningful_change": false,       // TRUE ONLY IF at least one tier="alert" exists
  "has_pending_confirmation": false,   // TRUE ONLY IF at least one tier="alert_if_confirmed" exists
  "baseline_quality": {
    "level": "low",                     // "high", "medium", or "low"
    "issues": [                         // Reasons why baseline was low quality
      "baseline_pages_missing",
      "baseline_catalog_unclassified",
      "baseline_stale_meta",
      "baseline_different_pipeline"
    ]
  },
  "recommendation": "refresh baseline from a live crawl (--accept)",
  "coverage": {
    "old_links": 41,                   // Unique links in old link pool
    "new_links": 17,                   // Unique links in new link pool
    "ratio": 0.415                     // Ratio (< 0.5 triggered coverage guard)
  },
  "summary": "Minor updates logged (9 low-priority adjustments).",
  "changes": [                         // List of verified changes
    {
      "field": "catalog",
      "change_type": "catalog_expanded",
      "old_value": "12 commercial route families",
      "new_value": "product.infynd.com, infynd.com/b2b",
      "description": "New commercial product or service offerings added.",
      "tier": "log_only",              // "alert", "alert_if_confirmed", or "log_only"
      "needs_confirmation": false,
      "confidence": 0.6,
      "reason": "coverage_difference", // Explicit reason for tier downgrade
      "change_id": "a178a94d7443"
    }
  ],
  "baseline_gaps": [                   // Data present today but absent in old snapshot
    {
      "field": "phone",
      "change_type": "baseline_gap",
      "new_value": "+443338980725",
      "tier": "log_only"
    }
  ],
  "noise_detected": [],                // Cosmetic adjustments filtered out
  "unchanged_fields": [                // Confirmed stable fields
    "registration_number",
    "social_facebook",
    "social_linkedin"
  ],
  "not_found_fields": []               // Fields missing on both sides
}
```

---

## 6. Operational Modes & Advanced Functionality

`comparator.js` is not just a diff function; it is a full CLI suite designed for production pipelines. Here is how each operational mode works:

### 1. Automated Confirmation Engine (`--confirm`)
- **Command:** `node comparator.js --confirm [--confirm-delay <sec>] [--domain <domain>]`
- **Why it exists:** Real-world networks and web scrapers are flaky. A single page might fail to load an ATS link or a phone number once. Sounding alarms on a single run causes alert fatigue.
- **How it works:**
  1. Reads `results/comparison_results.json` looking for domains where `has_pending_confirmation === true`.
  2. If `--confirm-delay <sec>` is passed (default: 300s / 5 mins), it pauses to let transient web glitches clear.
  3. Re-crawls the website live (`secondLiveCrawl`).
  4. Runs two simultaneous comparisons:
     - **Old vs Second Live Crawl (`confResult`):** Did the change appear again?
     - **First Live Crawl vs Second Live Crawl (`liveVsLiveResult`):** Did the two live crawls agree?
  5. If the change reproduces in both, it is promoted from `alert_if_confirmed` to **`alert`** (`confirmed: true`, `has_meaningful_change = true`).
  6. If it was a baseline artifact or a one-off scraper glitch, it is dismissed without alerting.
  7. Calls `markChangeIdsReported()` to remember this change so it never alarms again.

---

### 2. Baseline Promotion Engine (`--accept`)
- **Command:** `node comparator.js --accept <domain>`
- **Why it exists:** When a company undergoes a major rebrand, catalog overhaul, or when a historical DB record is recognized as low-quality, we want to establish the fresh live crawl as the new official baseline.
- **How it works:**
  - Reads `data/new/<domain>.json` (the latest live crawl).
  - Atomically writes it to `data/old/<domain>.json` using `atomicWriteJson`.
  - Future comparisons for this domain will now compare against this clean, modern baseline.

---

### 3. High-Throughput Batch Processing (`--batch`)
- **Command:** `node comparator.js --batch <domains.txt> [--concurrency <num>] [--save-baseline]`
- **Why it exists:** Comparing thousands of domains sequentially would take days.
- **How it works:**
  - Reads a list of domains from a text file (ignores `#` comments and blank lines).
  - Spawns a concurrent worker pool (default concurrency: 3 workers).
  - Each worker picks the next domain, crawls, compares against `data/old/<domain>.json`, records the result, and tracks failure reasons.
  - Automatically loads `data/sent_state.json` to prevent re-alerting on previously acknowledged changes.
  - Prints a real-time progress summary with breakdown metrics.

---

### 4. Crawler Stability & Flakiness Testing (`--stability`)
- **Command:** `node comparator.js --stability <domains.txt> [--gap <sec>]`
- **Why it exists:** Before trusting a crawler in production, you must know its false positive rate. If a crawler visits the exact same website twice 2 minutes apart, it should find **zero** business changes.
- **How it works:**
  1. Crawls `domain.com` (Crawl 1).
  2. Waits for `--gap <sec>` (default: 120s).
  3. Crawls `domain.com` again (Crawl 2).
  4. Calls `evaluateStability(crawl1, crawl2)`:
     - Any `alert` or `alert_if_confirmed` between back-to-back crawls is flagged as a **FALSE POSITIVE**.
     - Minor text tweaks (`log_only`) are logged as noise.
  5. Computes the **Zero-FP Rate**: percentage of domains with 0 false alarms.
  6. Generates a comprehensive report saved to `results/stability_report.json`.

---

### 5. Alert State Tracking & Deduplication (`sentChangeIds`)
- **File:** `data/sent_state.json`
- **Why it exists:** If a company rebranded yesterday, you alert the user. If you crawl the company again tomorrow, you should **not** alert the user again!
- **How it works:**
  - Every detected change is given a deterministic 12-character hash: `change_id = hashChange(domain, field, newValue)`.
  - When an alert is reported, `markChangeIdsReported()` saves the hash into `data/sent_state.json`.
  - In all subsequent crawl runs, `comparator.js` checks `sentChangeIds`:
    - If `sentChangeIds.has(c.change_id)`, the change is marked `already_reported: true`.
    - Its tier is automatically downgraded to `log_only` with evidence `"(already reported previously)"`.
    - It is suppressed from triggering `has_meaningful_change`.

---

### 6. Network Resilience & Exponential Backoff (`fetchCrawlWithRetry`)
- The crawler API communicates over HTTP. Network hiccups or rate limits (HTTP 429 / 503) can happen.
- `fetchCrawlWithRetry(domain, maxRetries = 3)`:
  - If a request fails with a network error or rate limit, it waits with exponential backoff: $2000\text{ms} \times 2^{\text{attempt}}$.
  - Retries up to 3 times before recording an error.
  - Calls `classifyErrorReason(err)` to categorize failures into `timeout`, `http_code`, `dns_error`, `invalid_json`, or `empty_crawl_data`.

---

### 7. Atomic File Writing (`atomicWriteJson`)
- In concurrent multi-worker environments, writing directly to `results.json` can cause file corruption if two processes write at the same time or if a process is killed mid-write.
- `atomicWriteJson(filePath, data)`:
  - Writes data to a unique temporary file first: `.tmp_<timestamp>_<random>.json`.
  - Uses OS-level `fs.renameSync(tmp, filePath)` to replace the destination file in a single atomic filesystem operation.

---

## 7. CLI Usage Cheat Sheet

```bash
# 1. Run all 35 automated mutation unit tests
node comparator.js --selftest

# 2. Compare any old baseline file with a new crawl file
node comparator.js data/old/example.com.json data/new/example.com.json

# 3. Crawl a single domain live, compare against baseline, and save results
node comparator.js --domain example.com [--save-baseline]

# 4. Run a concurrent batch crawl and comparison on a list of domains
node comparator.js --batch domains.txt --concurrency 5 --save-baseline

# 5. Re-crawl pending domains to confirm suspected changes
node comparator.js --confirm --confirm-delay 120

# 6. Promote a live crawl to become the official baseline
node comparator.js --accept example.com

# 7. Run crawler stability evaluation to verify zero false positives
node comparator.js --stability data/stability_domains.txt --gap 60
```

