# Complete Guide: How the Website Change Comparator Works
> *A plain-English guide to understanding the entire website comparison system, the bugs that were discovered, and how each fix was engineered.*

---

## 1. The Big Picture: What Are We Building?

### The Core Problem
We have a system that collects information about millions of companies by crawling their websites:
1. **The Past (Old Snapshot / DB Baseline):** Data saved in a PostgreSQL database (`company_profile_global`).
2. **The Present (New Snapshot / Live Crawl):** The crawler re-visits the company's website today and extracts current data.
3. **The Comparator (`comparator.js`):** Compares the **Old** snapshot and the **New** snapshot to answer one question:
   > **"Did this business actually change in a meaningful way?"**

### What Counts as a "Real Business Change"?
- **Yes (Real Change):**
  - Company changed its name / rebranded (e.g., from "Acme Tools" to "Apex Industrial").
  - Company relocated its physical office (address changed, confirmed by Google Maps).
  - Domain redirected to a completely different company (e.g., `brandA.com` acquired by `brandB.com`).
  - Company adopted an external hiring platform (e.g., switched from no career page to `jobs.lever.co/brand`).
  - Official company registration number changed.

- **No (Noise / Technical False Alarm):**
  - Apex domain redirected to `www` (`whitesbodyworks.com` -> `www.whitesbodyworks.com`).
  - Crawler explored 40 pages in the old crawl, but only 18 pages today (coverage difference).
  - Database had `contactPage = null`, but today the crawler visited `/contact` and extracted a phone number that existed for 10 years (baseline gap, not a new phone number).
  - Minor text rephrasing in marketing slogans.
  - Page title structure changed (e.g., "Wedding dress | White Studio Bridal" vs "White Studio Bridal").

---

## 2. The 3 Alert Tiers

Every detected change is assigned to one of three tiers:

| Tier | Meaning | Action Taken |
| :--- | :--- | :--- |
| **`alert`** | **Critical, confirmed business event.** | High priority! Flagged immediately (`has_meaningful_change = true`). |
| **`alert_if_confirmed`** | **Suspicious major change that might be temporary noise.** | Put into pending state (`has_pending_confirmation = true`). Requires a second crawl before alerting. |
| **`log_only`** | **Minor or informational change.** | Saved to history for audit/logging, but does NOT trigger alarms (`has_meaningful_change = false`). |

---

## 3. The 11 Problems & How We Fixed Them (Step-by-Step)

Here is a breakdown of the 11 specific improvements made to the comparator:

### Fix 1: Universal URL Extraction (`extractUrls`)
- **The Bug:** In the PostgreSQL database, links were stored as pipe-delimited strings (`"https://a.com|https://b.com"`). But the live crawler returned bracket strings (`"[https://a.com, https://b.com]"`). The old parser choked on pipe characters, causing old links to look completely empty!
- **The Fix:** Built `extractUrls(val)` that accepts arrays, bracket strings, pipe-delimited strings, and nested objects. It uses regex to extract every URL, strips trailing punctuation, normalizes them, and removes duplicates.

### Fix 2: Baseline Quality Scoring (`baseline_quality`)
- **The Bug:** If an old DB record was missing pages (e.g., `contactPage` was `null`), the comparator compared a blank page against a live page and screamed "Everything is new!"
- **The Fix:** The comparator analyzes the baseline snapshot first. It checks for:
  1. `baseline_pages_missing`: Contact, about, or terms pages are null in the old record but populated now.
  2. `baseline_catalog_unclassified`: Old products array is empty even though commercial links exist.
  3. `baseline_stale_meta`: Old title/description does not match old homepage content.
  4. `baseline_different_pipeline`: Snapshot came from an older DB format without raw fields.
  - If 2 or more issues exist, `baseline_quality.level` is marked **`low`**.

### Fix 3: Baseline Gaps vs. Real Additions
- **The Bug:** When a field is populated today solely because a page was crawled that was missing in the old DB snapshot, calling it "added" is false.
- **The Fix:** Such findings are moved to `baseline_gaps` (`tier: log_only`, `change_type: baseline_gap`). Furthermore, when baseline quality is `low`, all content changes (catalog, description, subdomains, phones, emails) are capped at `log_only`, and the system suggests: `"refresh baseline from a live crawl (--accept)"`.

### Fix 4: Symmetrical Raw Link Pool
- **The Bug:** The live crawler classified links into `productLinks`, `serviceLinks`, `ecommerceLinks`. But the DB baseline stored everything in a single pool (`home_alllinks`). Comparing `productLinks` in new vs empty `productLinks` in old triggered fake alerts.
- **The Fix:** Both old and new snapshots are gathered into a raw pool (`homeLinks` + all `*LinksAll` + `otherLinks`). The exact same classification algorithm runs symmetrically on both sides.

### Fix 5: Smart Phone Extraction & Regional Hints
- **The Bug:** 
  1. Phone numbers were using `ipCountry` as region hint. If a UK business hosted its site on an AWS server in Germany, German phone prefixes were wrongly extracted (`+4912150394`).
  2. Numbers were extracted without context, mistaking UK Company Registration numbers (`12150394`) for phone numbers!
- **The Fix:**
  1. Priority order for phone country: Phone's own `+` prefix > Address country > Postcode pattern > Website TLD > Language. Never use `ipCountry`.
  2. Require phone context: Must have a `tel:` link, a phone label (`phone`, `tel`, `call`, `t:`, `p:`) within 20 characters, or standard `+`/`(0` notation.
  3. Reject any number that matches the company registration number.

### Fix 6: Company Registration Number Verification
- **The Bug:** DB records had `registration_number: "12150394"`, while the live crawler had this number in the page text. The old comparator reported `registration_number: not_found`.
- **The Fix:** Top-level fields (`registration_number`, `address`, `postal_code`) are checked on the baseline. When page text extracts the registration number and it matches the old record, it is marked `unchanged`.

### Fix 7: Non-Circular Corroboration & Stale Metadata
- **The Bug:** A description change alert previously required "corroboration". But the system was using unverified signals to corroborate itself.
- **The Fix:** A signal can only corroborate if it is an independent, validated change. When `homeContent` between old and new is identical, title and description changes remain `log_only` with reason `baseline_stale_meta`.

### Fix 8: Coverage Ratio Guard (0.5 to 2.0)
- **The Bug:** Web crawlers sometimes crawl fewer pages on one run (e.g., 17 pages) than on a previous run (41 pages). The comparator was reporting that 24 product routes were "deleted"!
- **The Fix:** The comparator calculates the link coverage ratio (`new_links / old_links`). If the ratio is outside `0.5` to `2.0` (more than 2x difference or more than 50% drop), catalog expansion/reduction and subdomain additions/removals are automatically downgraded to `log_only` with explicit reason `coverage_difference`.

### Fix 9: Special Links Diffing (`otherLinks`)
- **The Bug:** `otherLinks` subfields (`contactUs`, `blog`, `career`, `team`) were previously ignored or misclassified.
- **The Fix:**
  - Changes in `otherLinks.contactUs` (e.g., moving from `/contact` to a subdomain `sentinel.infynd.com`) are reported as `log_only` modifications.
  - Career recruitment ATS changes (e.g., moving to `jobs.lever.co`) only trigger `alert_if_confirmed` if a career link already existed in the baseline.

### Fix 10: Confirmation Engine (Live vs. Live Re-Crawl)
- **The Bug:** In confirmation mode (`--confirm`), the system crawled a second time and compared Old vs Live2. If the Old baseline was dirty, the same false alarm reproduced, confirming a fake change!
- **The Fix:** `confirmChanges` now compares:
  1. **Old vs Live2:** Did the change appear?
  2. **Live1 vs Live2:** Does the change reproduce between the two live crawls?
  - A baseline artifact appears in Old vs Live, but NOT in Live1 vs Live2. This filters out baseline artifacts automatically.

### Fix 11: Redirect Normalization (Apex vs. WWW)
- **The Bug:** `whitesbodyworks.com` redirected to `www.whitesbodyworks.com`. The crawler flagged `redirection = true`, which caused the comparator to sound a major alarm: `"Domain redirected to www.whitesbodyworks.com!"` and skipped comparing the actual company content!
- **The Fix:**
  - Using `tldts`, the comparator checks the registrable domain (e.g., `whitesbodyworks.com`).
  - Redirects from apex to `www`, `http` to `https`, or trailing slashes within the same root domain are NOT treated as `domain_redirect`. The system continues with a full field-by-field content comparison.

---

## 4. The 35 Automated Selftests

To guarantee that none of these bugs can ever happen again, we have 35 automated tests (`node comparator.js --selftest`):

1. **Case 1:** HTTP 403 Forbidden marked inconclusive.
2. **Case 2:** Page content drop >70% marked inconclusive (JS rendering required).
3. **Case 3:** Phone number change in contact page triggers `alert`.
4. **Case 4:** Phone number moving from page text into the phone field is marked `unchanged`.
5. **Case 5:** Postcode change alone is `alert_if_confirmed`; with Maps link is `alert`.
6. **Case 6:** Rebranding (name + title + clearbit change) triggers `alert`.
7. **Case 7:** Description rewrite alone is `log_only`; with corroborated catalog is `alert_if_confirmed`.
8. **Case 8:** Informational `/blog/` links do not trigger catalog alert.
9. **Case 9:** New business subdomain (`portal.domain.com`) triggers `alert_if_confirmed`; CDNs ignored.
10. **Case 10:** Email address replaced entirely triggers `alert_if_confirmed`; extra email is `log_only`.
11. **Case 11:** Career link moved to Lever ATS triggers `alert_if_confirmed`.
12. **Case 12:** Twitter handle matching existing X handle is `unchanged`.
13. **Case 13:** Company registration number change triggers `alert`.
14. **Case 14:** Field missing in new crawl goes to `not_found_fields`, no alert.
15. **Case 15:** Extra schema field added is `log_only`.
16. **Case 16:** Link format conversion (array vs bracket string) is `unchanged`.
17. **Case 17:** Apex to WWW redirect continues normal comparison; external domain alerts.
18. **Case 18:** Brand from title selects best segment using token overlap.
19. **Case 19:** Route variants collapse into families; ratio > 2.0 downgrades to `log_only`.
20. **Case 20:** Phone corroboration requires 2+ independent sources for direct `alert`.
21. **Case 21:** Output semantics: `has_meaningful_change` only true for tier `alert`.
22. **Case 22:** Confirmation reproduces changes; `sentChangeIds` marks `already_reported`.
23. **Case 23:** Stability test mode flags alerts between identical crawls as false positives.
24. **Case 24:** Error classifier handles timeouts, DNS errors, and invalid JSON.
25. **Case 25:** `extractUrls` parses pipe, bracket, arrays, and nested objects.
26. **Case 26:** Baseline quality computes 4 issues and marks level `low`.
27. **Case 27:** Baseline gaps categorized; low baseline caps content changes at `log_only`.
28. **Case 28:** Raw link pools gathered symmetrically for catalog, subdomains, and social.
29. **Case 29:** Phone prioritizes address country/postcode over IP, excludes registration number.
30. **Case 30:** Registration number in page text compared against top-level field.
31. **Case 31:** Identical homeContent keeps description/title `log_only` (`baseline_stale_meta`).
32. **Case 32:** Coverage guard downgrades catalog and subdomains with reason `coverage_difference`.
33. **Case 33:** OtherLinks shifts reported as `log_only`; career ATS guarded without prior baseline.
34. **Case 34:** Confirmation engine filters baseline artifacts via Live1 vs Live2 comparison.
35. **Case 35:** Complete end-to-end assertion on real DB baseline pair.

---

## 5. Summary of Real-World Results

| Domain | Before Fixes | After Fixes | Why it Changed |
| :--- | :--- | :--- | :--- |
| **`whitesbodyworks.com`** | `has_meaningful_change: true`<br>Alert: `domain_redirect` | **`has_meaningful_change: false`**<br>Changes: `0` | Apex-to-www redirect recognized as the same site; full comparison confirmed 100% content match. |
| **`whitestudiolondon.com`** | `has_meaningful_change: true`<br>Alert: catalog expanded<br>Drift: brand name | **`has_meaningful_change: false`**<br>Log only: `nameFromCopyright` | Brand title parser scored "White Studio Bridal" correctly. Catalog routes collapsed into single family. |
| **`infynd.com`** | `has_meaningful_change: true`<br>Multiple alerts (catalog, subdomains, description) | **`has_meaningful_change: false`**<br>`baseline_quality: low`<br>All capped to `log_only` | Low baseline quality recognized; DB artifacts separated from true changes; coverage difference applied. |

---

## 6. How to Run Everything

```bash
# 1. Run all 35 automated selftests
node comparator.js --selftest

# 2. Compare any old baseline file with a new crawl file
node comparator.js data/old/infynd.com.json data/new/infynd.com.json

# 3. Promote a live crawl into the baseline
node comparator.js --accept infynd.com
```

