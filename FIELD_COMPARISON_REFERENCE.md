# Complete Reference: All Fields, Scoring Math & Status Types

This document provides the definitive guide for **all 30+ fields** found in the company crawl snapshot JSON, explaining:
1. How every field is categorized.
2. What operations the **Field Scorer** and **Comparator Engine** perform on each field.
3. The exact types of scores, weights, and status values.
4. How the **Total Change Score** is calculated.

---

## 1. Field Categorization Architecture

The 30+ fields in the snapshot are organized into **5 functional tiers**:

| Category | Fields | Role in Scoring |
| :--- | :--- | :--- |
| **Tier 1: Core Business Profile** | `company_name`, `title`, `description`, `phone`, `email`, `address`, `postal_code`, `registration_number`, `website`, `tagline`, `social_links`, `catalog_routes` | **Direct Impact on Total Score (0–100 pts)**. Represents legal, contact, and commercial changes. |
| **Tier 2: Content Page Bodies** | `home_content`, `about_page`, `contact_page`, `privacy_page`, `terms_page` | **Text Similarity Tracking (0–100%)**. Used by Comparator to corroborate or reject claim of rebrand/pivot. |
| **Tier 3: Technical Infrastructure** | `response_code`, `host_ip`, `ip_country`, `web_server`, `load_time_ms`, `domain_status` | **Network & Site Health**. Tracks CDN routing, DNS, and server software changes (0 pts penalty). |
| **Tier 4: Auxiliary Identity Signals** | `name_from_title`, `name_from_copyright`, `clearbit_name`, `image_url`, `language` | **Fallback Brand Verification**. Used by Comparator to detect whether brand name is still in footer copyright. |
| **Tier 5: Navigation & Link Pools** | `home_links`, `contact_links`, `about_links`, `other_links` | **Link Discovery & Coverage Guard**. Validates route additions vs baseline pipeline gaps. |

---

## 2. Status Types and Definitions

Every single field produces an exact status:

| Status Code | Meaning | Score Impact | Returned Value |
| :--- | :--- | :---: | :--- |
| **`UNCHANGED`** | Values match exactly across baseline and crawl (or within $\ge 85\%$ word similarity for text). | **0 pts** | Returns original value as-is. |
| **`MODIFIED`** | Value changed to a different value (or text similarity $< 85\%$). | **5 to 25 pts** | Returns both `old` and `new` values. |
| **`NOT_FOUND_IN_CRAWL`** | Field existed in the DB baseline, but the crawler did not extract it. | **5 to 10 pts** | Returns `old` value and `new: null`. |
| **`ADDED`** | Field was null in DB baseline, but newly extracted in live crawl. | **5 pts** | Returns `old: null` and `new` value. |
| **`REDIRECTED`** | Website URL redirected to another domain. | **20 pts** | Returns original domain and target domain. |

---

## 3. How the Total Change Score is Calculated

The **Total Change Score** is a weighted sum between **0 and 100 points**:

$$\text{Total Change Score} = \min\left(100, \sum \text{Core Field Scores}\right)$$

### Scoring Table:

| Field | Weight | If `UNCHANGED` | If `MODIFIED` | If `NOT_FOUND_IN_CRAWL` | If `ADDED` |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **`company_name`** | **25 pts** | 0 | 25 (Rebrand) | 10 | 5 |
| **`registration_number`** | **25 pts** | 0 | 25 (Legal CRN change) | 5 | 5 |
| **`description`** | **20 pts** | 0 | 5 (Minor) / 20 (Major) | 10 | 5 |
| **`website`** | **20 pts** | 0 | 20 (External Redirect) | 0 | 0 |
| **`phone`** | **15 pts** | 0 | 15 (Phone changed) | 5 | 5 |
| **`email`** | **15 pts** | 0 | 15 (Email changed) | 5 | 5 |
| **`address`** | **15 pts** | 0 | 15 (Relocation) | 5 | 5 |
| **`catalog_routes`** | **10 pts** | 0 | 10 (Catalog routes shift) | 0 | 5 |
| **`title`** | **10 pts** | 0 | 10 (Title changed) | 5 | 5 |
| **`postal_code`** | **10 pts** | 0 | 10 (Postcode changed) | 5 | 5 |
| **`social_links`** | **5 pts** | 0 | 5 (Social handle shift) | 0 | 5 |
| **`tagline`** | **5 pts** | 0 | 5 (Tagline changed) | 5 | 5 |

### Change Level Thresholds:
- **`0 - 15`**: **LOW CHANGE** (Cosmetic updates, minor wording adjustments)
- **`16 - 39`**: **MEDIUM CHANGE** (Single contact update or moderate description rewrite)
- **`40 - 100`**: **HIGH CHANGE** (Meaningful business change: rebrand, relocation, or legal number change)

---

## 4. Operation-by-Operation Breakdown for All 30+ Fields

Using **`whitestudiolondon.com`** as our live reference:

### Tier 1: Core Business Profile Fields

#### 1. `company_name`
- **Field Scorer**: Checks `old.companyName` ("White Studio") vs `new.companyName` (null). Detects missing value in crawl header $\rightarrow$ `status: "NOT_FOUND_IN_CRAWL"`, **Score: 10**.
- **Comparator**: Cross-checks footer copyright (`nameFromCopyright: "White Studio"`). Concludes the brand did **not** change, suppressing false rebrand alerts.

#### 2. `description`
- **Field Scorer**: Word-overlap Jaccard similarity between old (662 ch) and new (353 ch) descriptions is **19%**. Since $19\% < 45\%$, flags `status: "MAJOR_CHANGE"`, **Score: 20**.
- **Comparator**: Non-circular corroboration check — compares `home_content`. Since homepage body text is **100% identical**, marks `[LOG_ONLY]`.

#### 3. `phone`
- **Field Scorer**: Cleans digits (`2083681500`). Missing in crawl header $\rightarrow$ `status: "NOT_FOUND_IN_CRAWL"`, **Score: 5**.
- **Comparator**: Scans page bodies for `tel:` links; rejects numbers matching UK registration number `08742433`.

#### 4. `email`
- **Field Scorer**: Lowercases `info@whitestudiolondon.com` on both sides. Exact match $\rightarrow$ `status: "UNCHANGED"`, **Score: 0**.
- **Comparator**: Verifies domain alignment and marks confirmed unchanged.

#### 5. `address`
- **Field Scorer**: Old had `"Unit D3 Friarsgate..."`, new header is null $\rightarrow$ `status: "NOT_FOUND_IN_CRAWL"`, **Score: 5**.
- **Comparator**: Checks Google Maps links (`maps.google.com`) on contact page to verify no office relocation occurred.

#### 6. `registration_number`
- **Field Scorer**: Old had `"08742433"`, new header is null $\rightarrow$ `status: "NOT_FOUND_IN_CRAWL"`, **Score: 5**.
- **Comparator**: Regex scan for 8-digit legal company numbers in contact and about page footers.

#### 7. `website`
- **Field Scorer**: Compares hostname `whitestudiolondon.com` $\rightarrow$ `status: "UNCHANGED"`, **Score: 0**.
- **Comparator**: Inspects HTTP status (200 OK) and ensures canonical redirect is valid.

#### 8. `title`
- **Field Scorer**: Word similarity on `<title>` tag is **100%** $\rightarrow$ `status: "UNCHANGED"`, **Score: 0**.
- **Comparator**: Confirmed identical across records.

#### 9. `postal_code` & `tagline`
- **Field Scorer**: Both empty or matching in old and new $\rightarrow$ `status: "UNCHANGED"`, **Score: 0**.

#### 10. `social_links`
- **Field Scorer**: LinkedIn URL added a tracking query parameter (`?lipi=...`) $\rightarrow$ `status: "MODIFIED"`, **Score: 5**.
- **Comparator**: Normalizes domain variations (`x.com` vs `twitter.com`) and ignores tracking parameters.

#### 11. `catalog_routes`
- **Field Scorer**: New crawl discovered 3 collection routes where DB had empty array `[]` $\rightarrow$ `status: "MODIFIED"`, **Score: 10**.
- **Comparator**: Applies **Coverage Guard** — caps at `[LOG_ONLY]` because old DB baseline links were unclassified.

---

### Tier 2: Content Page Bodies

#### 12. `home_content` (Homepage Body Text)
- **Field Scorer**: Runs Jaccard similarity across the full 2,775-character homepage text.
  - Result: **100% similarity!**
  - `status: "UNCHANGED"`, **Score: 0**.
- **Comparator**: The critical anchor of the system: because `home_content` is 100% identical, all metadata description shifts are proven to be cosmetic.

#### 13. `about_page` & `contact_page`
- **Field Scorer**: Evaluates body text of `/about` and `/contact`.
  - Both match with **100% similarity** $\rightarrow$ `status: "UNCHANGED"`, **Score: 0**.
- **Comparator**: Confirms company story and contact details have not shifted.

#### 14. `privacy_page` & `terms_page`
- **Field Scorer**: Null on both sides $\rightarrow$ `status: "UNCHANGED"`, **Score: 0**.

---

### Tier 3: Technical & Infrastructure Fields

#### 15. `response_code` (HTTP Status)
- **Operation**: Compares HTTP status. Both return `200` $\rightarrow$ `status: "UNCHANGED"`, **Score: 0**.

#### 16. `host_ip` & `ip_country`
- **Operation**: Old had Direct IP `172.66.3.8` (UK); new has Cloudflare Anycast IP `162.159.143.12` (USA).
  - Flags `status: "MODIFIED"` (Score: 0) to notify of Cloudflare CDN edge routing shift.

#### 17. `web_server` & `domain_status`
- **Operation**: Server is `"jsoup"` and domain status is `"Valid"` on both sides $\rightarrow$ `status: "UNCHANGED"`, **Score: 0**.

#### 18. `load_time_ms`
- **Operation**: 131 ms vs 113 ms $\rightarrow$ normal network variance.

---

### Tier 4: Auxiliary Identity Signals

#### 19. `name_from_copyright`
- **Operation**: Old had `null`; live crawl extracted `"White Studio"`.
  - Scorer flags `status: "ADDED"`.
  - Comparator uses this to prove the company name is still `"White Studio"`.

#### 20. `name_from_title`
- **Operation**: Extracted segment `"White Studio Bridal"`.
  - Flags `status: "MODIFIED"`.

#### 21. `language`
- **Operation**: `"en"` on both sides $\rightarrow$ `status: "UNCHANGED"`, **Score: 0**.

---

### Tier 5: Navigation & Link Pools

#### 22. `home_links`
- **Operation**: Compares all 20 internal and external links found on the homepage.
  - All 20 URLs match $\rightarrow$ `status: "UNCHANGED"`, **Score: 0**.

#### 23. `contact_links` & `about_links`
- **Operation**: All target URLs match (`/contact`, `/about`) $\rightarrow$ `status: "UNCHANGED"`, **Score: 0**.

#### 24. `other_links`
- **Operation**: Header and footer link shift (`status: "MODIFIED"`).

---

## 5. Complete Summary for `whitestudiolondon.com`

```text
TOTAL CHANGE SCORE:      60 / 100 [HIGH CHANGE]
BUSINESS VERDICT:        Meaningful changes detected
SUMMARY:                 Changed: description, social links, catalog routes | Not found in crawl: company name, phone, address, registration number
BASELINE QUALITY:        LOW (Issues: baseline_pages_missing, baseline_catalog_unclassified, baseline_different_pipeline)
```
