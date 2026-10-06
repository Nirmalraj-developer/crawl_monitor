# Comparator Engine Documentation (`comparator.js`)

## 1. Overview & Purpose
The **Comparator Engine** (`comparator.js`) is the core analytical component of the change detection pipeline. It compares a **historical stored crawl JSON** against a **fresh crawl JSON** for any company domain.

Its primary goal is to **maximize the detection of genuine business changes** while **filtering out 100% of superficial web noise** (dynamic copyright years, cookie banners, minor copywriting tweaks, and corporate legal entity suffixes).

---

## 2. High-Level Architecture & Data Flow

```
                      ┌────────────────────────────────┐
                      │   Old Snapshot vs. New Crawl   │
                      └───────────────┬────────────────┘
                                      │
                                      ▼
                        extractRecord() Normalizer
                 • Unwraps JSON arrays & API envelopes
                 • Strips cosmetic dates & copyright noise
                 • Parses subdomains, portals & social links
                 • Normalizes phones (+44, +1, +91, trunk 0)
                 • Normalizes brand stems (strips Ltd, Pvt, etc.)
                                      │
                                      ▼
                 ┌───────────────────────────────────────────┐
                 │       12-Dimension Evaluation Checks      │
                 └────────────────────┬──────────────────────┘
                                      │
          ┌───────────────────────────┴───────────────────────────┐
          ▼                                                       ▼
   [Genuine Business Changes]                               [Filtered Noise]
   • Subdomains deployed (app.*, product.*)                • "InFynd" vs "InFynd Group"
   • Thematic positioning pivot                            • Minor wording edits (similarity >= 60%)
   • Catalog expansion / discontinuation                   • Formatted phone variations
   • Phone / office / email / social updates               • Dynamic dates & copyright notices
```

---

## 3. The 12 Evaluation Dimensions in Detail

### 1. Website Status & Availability (`website_status`)
- **Source Fields**: `item.responseCode`, `item.homeContent`
- **Extraction & Detection**:
  - Checks if `responseCode === '404'` or `'500'`.
  - Scans `homeContent` for critical server and DNS failure phrases: `"404 Not Found"`, `"NoSuchKey"`, `"domain for sale"`, `"this domain is parked"`.
- **Decision Logic**:
  - If detected, the comparator halts further field evaluations immediately to prevent false alerts.
  - Returns an immediate critical status: `website_status: down_or_parked` with confidence `1.0` and flags `requires_human_review: true`.

### 2. Company Brand Identity & Rebranding (`company_name`)
- **Source Fields**: `item.nameFromTitle`, `item.clearbitName`, `item.companyName`, `item.name`
- **Cleaning via `normalizeBrandStem()`**:
  1. Lowercases the string and strips punctuation (`infynd group` / `infynd pvt ltd`).
  2. Runs a RegEx suffix stripper for legal entity types:
     `\b(private limited|pvt ltd|pvt|limited|ltd|inc|corp|llc|gmbh|plc|co)\b`
  3. Strips corporate modifiers:
     `\b(group|holdings|technologies|solutions|services|enterprises)\b`
- **Comparison & Verdict**:
  - Compares `oldStem` vs `newStem`.
  - **Example 1**: `"InFynd"` vs `"InFynd Group"` $\to$ Both normalize to `"infynd"`.
    - *Verdict*: Classified as entity styling variant. Recorded in `noise_detected` and kept as **unchanged**.
  - **Example 2**: `"InFynd"` vs `"Aura Labs"` $\to$ Normalized stems differ.
    - *Verdict*: Flagged as genuine `company_name: rebrand` (`confidence: 0.95`).

### 3. Registered Legal Entity (`legal_entity_name`)
- **Source Fields**: `item.nameFromCopyright`, `item.contactPage`, `item.privacyPage`
- **Extraction via Pattern Matching**:
  - Scans contact and legal pages with RegEx looking for registered business suffixes:
    `match(/([A-Za-z0-9\s]+(?:LTD|LIMITED|INC|LLC|CORP|GMBH|PLC))\b/i)`
  - *Example match*: `"ProminentContact LTD"`.
- **Comparison & Verdict**:
  - If the registered corporate entity behind the domain changes (e.g. from `ProminentContact LTD` to `Global Data Ventures PLC`):
    - *Verdict*: Flagged as corporate ownership / legal acquisition update (`confidence: 0.92`).

### 4. Description & Value Proposition (`description`)
- **Source Fields**: `item.description`
- **Cleaning via `stripCosmeticNoise()`**:
  - Strips dynamic dates, copyright notices (`© 2026`), and standard legal notices.
- **Math via Token Jaccard Similarity**:
  1. Tokenizes both strings into word sets (excluding words $\le 2$ characters).
  2. Computes set overlap:
     $$\text{Similarity} = \frac{|Set_{\text{old}} \cap Set_{\text{new}}|}{|Set_{\text{old}} \cup Set_{\text{new}}|}$$
- **Threshold Decision**:
  - **Similarity $\ge 0.60$ (60%+ words overlap)**: Classified as copywriting refresh / marketing polish $\to$ Added to `noise_detected` and preserved as **unchanged**.
  - **Similarity $< 0.60$ (Significant semantic drift)**: Flagged as `description: modified` (`confidence: 0.92`) with the exact match percentage recorded as evidence.

### 5. Market Positioning & Topic Pivot (`market_positioning`)
- **Source Fields**: `item.home_content`, `item.description`
- **Extraction via `extractTopicKeywords()`**:
  - Universal frequency-based topic extraction (stop-word removal on `the`, `and`, `for`, `with`, `across`, etc.).
  - Extracts the top 5 dominant business keywords across the entire homepage.
- **Comparison & Verdict**:
  - Compares the top 5 old thematic keywords against the top 5 new thematic keywords.
  - If overlap between thematic vectors drops to **$\le 1$ keyword** (meaning 80%+ of core messaging altered):
    - *Example*: Old was `[infynd, provides, lists, contact]` $\to$ New is `[data, healthcare, risk, platform]`.
    - *Verdict*: Flagged as `market_positioning: thematic_pivot` (`confidence: 0.90`). Fully dynamic without hardcoded names.

### 6. Subdomains & SaaS Infrastructure (`subdomains_infrastructure`)
- **Source Fields**: `item.homeLinks`, `item.contactLinksAll`, `item.productLinks`, `item.otherLinks`
- **Extraction via `extractSubdomainsAndPortals()`**:
  - Parses all discovered URLs on the site using the native `URL` parser.
  - Collects all valid custom subdomains ending in `.<domain>` (excluding `www`).
  - Identifies dedicated client/app portals (`/auth`, `/login`, `/app`).
- **Set Difference Comparison**:
  - $\text{Added Subdomains} = \text{New Subdomains} \setminus \text{Old Subdomains}$
  - $\text{Removed Subdomains} = \text{Old Subdomains} \setminus \text{New Subdomains}$
- **Verdict**:
  - If new subdomains appear (e.g. `app.infynd.com`, `product.infynd.com`): Flagged as `infrastructure_expanded` (`confidence: 0.95`).
  - If subdomains disappear: Flagged as `infrastructure_reduced`.

### 7. Products & Services Catalog (`products_and_services`)
- **Source Fields**: `item.productLinks`, `item.serviceLinks`, `item.ecommerceLinks`
- **Cleaning via `cleanUrl()`**:
  - Normalizes URLs by removing protocol (`https://`), `www.`, tracking parameters (`?utm_*`), and trailing slashes.
- **Set Difference Comparison**:
  $$\text{Added Products} = \text{Set}(\text{New}) \setminus \text{Set}(\text{Old})$$
  $$\text{Discontinued Products} = \text{Set}(\text{Old}) \setminus \text{Set}(\text{New})$$
- **Verdict**:
  - If new solution routes appear (e.g. `/esg-compliance`, `/risk-compliance`, `/data-integration`): Flagged as `catalog_expanded` (`confidence: 0.92`).
  - If existing solution routes vanish: Flagged as `catalog_reduced`.

### 8. Contact Phone Numbers (`phone`)
- **Source Fields**: `item.phone`, `item.phoneFormatted`, RegEx on `item.contactPage`
- **Cleaning via `normalizePhone()`**:
  1. Strips all non-digit formatting: `replace(/\D/g, '')`.
  2. Strips international calling country codes:
     - Leading UK `44`.
     - Leading US/Canada `1` (if 11 digits).
     - Leading India `91`.
  3. Strips leading trunk zero `0`.
- **Comparison & Verdict**:
  - *Example 1*: `+44 (0) 20 8089 2420` and `02080892420` both reduce to `2080892420`.
    - *Verdict*: Identical normalized digits $\to$ Marked **unchanged** (formatting difference ignored).
  - *Example 2*: `+44 20 8089 2420` vs `+44 3338 980725` $\to$ Digits differ.
    - *Verdict*: Flagged as `phone: modified` (`confidence: 0.95`).

### 9. Contact Email Channels (`email`)
- **Source Fields**: `item.email`, `item.genericEmail`
- **Extraction & Normalization**:
  - Parses multiple addresses using delimiters: `|`, `,`, or `;`.
  - Trims, lowercases, and validates that each string contains `@`.
- **Comparison & Verdict**:
  - Checks for mathematical set intersection (overlap).
  - If **zero overlap** exists between old email channels and new email channels:
    - *Verdict*: Flagged as `email: modified` (`confidence: 0.90`).
  - If at least one primary channel remains: Preserved as consistent channels.

### 10. Physical Office Address (`office_address`)
- **Source Fields**: `item.address`, RegEx on `item.contactPage`
- **Extraction**:
  - RegEx extracts building names, streets, and postal code formats (e.g., `Lily Hill House, Lily Hill Road, Bracknell, RG12 2SJ`).
- **Comparison & Verdict**:
  - Runs string similarity between the old address and the new address.
  - If similarity $< 0.60$ (indicating relocation to a different building, city, or postal code):
    - *Verdict*: Flagged as `office_address: relocated` (`confidence: 0.92`).
  - Minor formatting variations (similarity $\ge 0.60$) are sent to `noise_detected` and kept as **unchanged**.

### 11. Social Media Presence (`social_channels`)
- **Source Fields**: `item.socialLinks` (`facebook`, `instagram`, `linkedin`, `twitter`)
- **Extraction**:
  - Cleans profile URLs and excludes non-social policy links (`privacy`, `terms`).
- **Comparison & Verdict**:
  - Evaluates each platform handle independently:
    - New platform added (e.g. newly established Instagram).
    - Handle modified (e.g. handle renamed from `infynd` to `infynd_group`).
  - *Verdict*: Flagged as `social_channels: modified` (`confidence: 0.90`).

### 12. Careers & Talent Acquisition (`career_portal`)
- **Source Fields**: `item.otherLinks.career`
- **Extraction & Comparison**:
  - Normalizes the recruitment link destination.
  - Checks if the destination URL changed (e.g., migration from internal pages to Zoho Recruit, Lever, or Greenhouse).
  - *Verdict*: Flagged as `career_portal: modified` (`confidence: 0.88`).

---

### Field Comparison Summary Checklist

| # | Field Name | Type of Diff | Noise Filter Mechanism | Real-World Business Event |
| :---: | :--- | :--- | :--- | :--- |
| **1** | `website_status` | Status code & error phrases | Error phrase dictionary | Site down, expired hosting, parked |
| **2** | `company_name` | Stem Comparison | Legal suffix & modifier stripper | Rebrand vs corporate entity variant |
| **3** | `legal_entity_name` | RegEx Pattern Match | Corporate structure detector | Parent holding change, M&A |
| **4** | `description` | Jaccard Similarity ($< 0.60$) | Date and copyright stripper | Core value proposition shift |
| **5** | `market_positioning` | Topic Vector Overlap ($\le 1$) | Stop-word removal | Strategic business model pivot |
| **6** | `subdomains_infrastructure` | Hostname Set Difference | Custom URL parser | New SaaS platforms deployed |
| **7** | `products_and_services` | URL Route Set Difference | Clean URL normalizer | Catalog expansion or discontinuation |
| **8** | `phone` | Numeric Digit Match | Country code & trunk zero stripper | Call center / phone line change |
| **9** | `email` | Set Intersection | Multi-delimiter parser | Departmental email restructuring |
| **10**| `office_address` | String Similarity ($< 0.60$) | Postal code & street extractor | Physical headquarters relocation |
| **11**| `social_channels` | Key-Value Handle Diff | Platform handle normalizer | Social rebranding / handle migration |
| **12**| `career_portal` | URL Destination Match | ATS link detector | Hiring platform migration |

---

## 4. Input & Output Structure

### Function Signature:
```javascript
const { compareCrawls } = require('./comparator');

const result = compareCrawls(previousSnapshotJson, freshCrawlJson);
```

### Example Output JSON:
```json
{
  "domain": "infynd.com",
  "has_meaningful_change": true,
  "summary": "Identified 5 business change(s): description, market_positioning, subdomains_infrastructure, products_and_services, phone.",
  "changes": [
    {
      "field": "description",
      "old_value": "InFynd provides B2B contact lists and lead generation.",
      "new_value": "InFynd Group — a family of data and AI platforms powering smarter B2B growth, healthcare intelligence, risk insight, and AI-driven execution.",
      "change_type": "modified",
      "confidence": 0.92,
      "evidence": "Meta description updated (semantic similarity: 14%): \"InFynd Group — a family of data and AI platforms powering smarter B2B growth, healthcare intelligence, risk insight, and AI-driven execution.\"."
    },
    {
      "field": "market_positioning",
      "old_value": "infynd, provides, lists, contact",
      "new_value": "data, healthcare, risk, group",
      "change_type": "thematic_pivot",
      "confidence": 0.90,
      "evidence": "Primary homepage themes shifted from [infynd, provides, lists] to [data, healthcare, risk]."
    },
    {
      "field": "subdomains_infrastructure",
      "old_value": [
        "sentinel.infynd.com"
      ],
      "new_value": [
        "app.infynd.com",
        "product.infynd.com",
        "sentinel.infynd.com"
      ],
      "change_type": "infrastructure_expanded",
      "confidence": 0.95,
      "evidence": "New dedicated subdomains deployed: app.infynd.com, product.infynd.com."
    },
    {
      "field": "products_and_services",
      "old_value": [
        "infynd.com/b2b-contact-lists",
        "infynd.com/lead-generation",
        "infynd.com/pricing",
        "product.infynd.com"
      ],
      "new_value": [
        "infynd.com/blog/hcp-data-compliance-healthcare-marketer-guide",
        "infynd.com/data-integration",
        "infynd.com/esg-compliance",
        "infynd.com/pricing",
        "infynd.com/risk-compliance",
        "product.infynd.com"
      ],
      "change_type": "catalog_expanded",
      "confidence": 0.92,
      "evidence": "Discovered new product routes: infynd.com/blog/hcp-data-compliance-healthcare-marketer-guide, infynd.com/data-integration, infynd.com/esg-compliance, infynd.com/risk-compliance."
    },
    {
      "field": "phone",
      "old_value": "+44 20 8089 2420",
      "new_value": "+44 3338 980725",
      "change_type": "modified",
      "confidence": 0.95,
      "evidence": "Phone number changed from \"+44 20 8089 2420\" to \"+44 3338 980725\"."
    }
  ],
  "unchanged_fields": [
    "company_name",
    "email",
    "social_channels"
  ],
  "noise_detected": [
    "Entity suffix/legal styling variant ('InFynd' vs 'InFynd Group') - preserved as identical core brand."
  ],
  "requires_human_review": false,
  "evaluated_at": "2026-10-06T09:48:34.725Z"
}
```

---

## 5. Usage in Code

```javascript
const fs = require('fs');
const { compareCrawls } = require('./comparator');

// 1. Read stored snapshot and fresh crawl
const oldSnapshot = JSON.parse(fs.readFileSync('data/snapshots/example.com.json', 'utf8'));
const newCrawl = JSON.parse(fs.readFileSync('crawler_response.json', 'utf8'));

// 2. Run comparator
const diffResult = compareCrawls(oldSnapshot, newCrawl);

// 3. Check findings
if (diffResult.has_meaningful_change) {
  console.log(`Detected ${diffResult.changes.length} business changes!`);
  diffResult.changes.forEach(c => {
    console.log(`- [${c.field}] ${c.change_type}: ${c.evidence}`);
  });
} else {
  console.log('No meaningful business changes detected.');
}
```

