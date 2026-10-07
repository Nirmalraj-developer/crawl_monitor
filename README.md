# Crawl Monitor & Company Change Signal Analyzer

A high-precision company website change detection and signal analysis pipeline. Compares historical company crawl data against live website snapshots to determine meaningful business changes, filter out crawl noise, and alert on critical business shifts.

---

## Architecture Overview

```
OLD COMPANY JSON  +  NEW COMPANY JSON
             │
             ▼
    [1. Deterministic JSON Diff]          (src/diff/deterministic_diff.js)
    • Pure JavaScript diffing (NO AI)
    • Independent of key order, formatting, or whitespace
    • Emits ONLY changed field paths
             │
             ▼
    [2. Value Normalization Layer]        (src/normalization/normalizer.js)
    • Treats null ↔ "" ↔ undefined as NO_MEANINGFUL_CHANGE
    • Normalizes phones (E.164: +44), emails (case-folded), and strips URL tracking params
             │
             ▼
    [3. Field-Type Classification]        (src/config/field_analysis_config.js)
    • Categorizes fields: IDENTITY, CONTACT, LOCATION, NUMERIC, TEXT, URL, TECHNICAL
    • Strictly restricts permitted signals to avoid noisy false alarms
             │
             ▼
    [4. Field-Specific Six Signals]       (src/signals/)
    • Signal 1: Entity Changes        (Company names, Phones, Emails, Locations, Reg IDs)
    • Signal 2: Embedding Sim        (Dense semantic vector distance on narrative text)
    • Signal 3: TF-IDF + Cosine Sim   (Rare keyword overlap, stop words suppressed)
    • Signal 4: Jaccard Sim          (Lexical token set intersection over union)
    • Signal 5: Number Changes        (Business metrics, headcounts, revenues, years)
    • Signal 6: Negation Changes      (Polarity flips: "accepting" vs "not accepting")
    * STRICT RULE: Excludes Levenshtein, SimHash, and MinHash
             │
             ▼
    [5. Importance-First Scoring]         (src/scoring/scoring_engine.js)
    • Factual business changes (CRITICAL / HIGH) override text similarity
    • Missing-value events emit VALUE_REMOVED or VALUE_ADDED
             │
             ▼
    Is change Ambiguous or Divergent?
          ├── NO  ──> Resolved Deterministically (AUTO_ACCEPT / REVIEW / IGNORE)
          └── YES ──> [6. AI Escalation Gate] (src/classifier/ai_escalation_classifier.js)
                      • LLM classifies: CONTENT_UPDATE | CORRECTION | BUSINESS_CHANGE
             │
             ▼
    [7. Dual JSON Outputs]
    ├── Client-Friendly Report: results/<domain>_client_report.json (Plain English)
    └── Full Auditable JSON:    results/<domain>_signal_analysis.json (All raw metrics)
```

---

## Key Features

- **Field-Aware Six-Signal Engine**: Evaluates only applicable signals per field type (e.g. no embedding calculations on phone numbers or company names).
- **Noise Elimination**: Automatically normalizes empty strings, whitespace, and URL query tracking parameters.
- **Auditable & Explainable**: Preserves all raw signal values in the developer report.
- **Client-Friendly Reporting**: Translates technical diffs into plain, non-technical business language without exposing internal algorithm names or token counts.
- **Comparator Engine**: 35-rule mutation self-test suite covering corroboration, route families, and stability modes.

---

## Directory Structure

```text
├── src/
│   ├── config/
│   │   └── field_analysis_config.js    # Field categories & permitted signal mappings
│   ├── normalization/
│   │   └── normalizer.js               # Phone, email, URL, and null/empty normalizers
│   ├── diff/
│   │   └── deterministic_diff.js       # Pure recursive JSON diff
│   ├── signals/
│   │   ├── entity_changes.js           # Signal 1: Entity shifts (company, contact, location)
│   │   ├── embedding_similarity.js     # Signal 2: Semantic embedding vector distance
│   │   ├── tfidf_similarity.js         # Signal 3: TF-IDF + Cosine similarity
│   │   ├── jaccard_similarity.js       # Signal 4: Set intersection over union
│   │   ├── number_changes.js           # Signal 5: Business numbers & metrics
│   │   ├── negation_changes.js         # Signal 6: Operational polarity flips
│   │   └── index.js                    # Field-aware signal coordinator
│   ├── scoring/
│   │   └── scoring_engine.js           # Importance-first multi-signal scoring engine
│   ├── classifier/
│   │   └── ai_escalation_classifier.js # AI escalation arbitrator for ambiguous fields
│   ├── reporting/
│   │   └── client_report.js            # Client-friendly business report builder
│   └── index.js                        # Pipeline entrypoint
├── config/
│   ├── scoring_config.json             # Signal weights & threshold configurations
│   └── report_wording.json             # Banking report descriptions
├── data/
│   ├── old/                            # Historical baseline JSON records
│   └── new/                            # Live/fresh crawl JSON records
├── results/                            # Generated client and developer JSON reports
├── test/
│   └── field_aware_signals.test.js     # Field-aware signal test suite
├── analyze_changes.js                  # CLI runner for six-signal change analysis
├── comparator.js                       # Core comparator engine (35 selftests)
├── crawler_service.js                  # Website crawling service
├── index.js                            # DB baseline + live crawler pipeline
├── COMPARATOR_VS_SCORER_GUIDE.html     # Interactive documentation guide
└── SIX_SIGNAL_ANALYSIS_GUIDE.html      # Six-signal algorithmic guide
```

---

## Installation & Usage

### 1. Install Dependencies
```bash
npm install
```

### 2. Run Tests
```bash
npm test
```
Runs all 35 comparator selftests and 9 field-aware signal unit tests.

### 3. Analyze Changes on a Company
```bash
# Analyze by domain name (looks in data/old and data/new):
node analyze_changes.js --domain whitestudiolondon.com

# Run in debug mode (prints detailed signal metrics):
node analyze_changes.js --domain whitestudiolondon.com --debug

# Analyze two specific JSON files:
node analyze_changes.js data/old/company.json data/new/company.json
```

### 4. Run Comparator CLI
```bash
node comparator.js --selftest
node comparator.js data/old/whitestudiolondon.com.json data/new/whitestudiolondon.com.json --report
```

---

## Documentation

Open `COMPARATOR_VS_SCORER_GUIDE.html` or `SIX_SIGNAL_ANALYSIS_GUIDE.html` in any web browser for interactive visual guides detailing the field matrix, algorithms, and banking report formats.
