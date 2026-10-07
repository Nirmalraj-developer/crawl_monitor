/**
 * Company Content Change Analysis Pipeline (src/index.js)
 * --------------------------------------------------------
 * Refactored Architecture:
 * 1. Deterministic JSON Diff
 * 2. Normalization & Noise Filtering (removes empty strings / null equivalence)
 * 3. Field-Type Classification Layer (IDENTITY, CONTACT, LOCATION, NUMERIC, TEXT, URL, TECHNICAL)
 * 4. Field-Specific Six Signal Dispatcher (runs ONLY permitted signals per field type)
 * 5. Importance-First Rule-Based Scoring Layer (critical factual changes override text similarity)
 * 6. AI Escalation Gate (ONLY for genuinely ambiguous/high-divergence cases)
 * 7. Clean Internal Output & Client-Friendly Report Generator
 */

const fs = require('fs');
const path = require('path');
const { computeDeterministicDiff } = require('./diff/deterministic_diff');
const { extractAllSignalsForChanges } = require('./signals');
const { scoreFieldSignals, evaluateCompanyScores } = require('./scoring/scoring_engine');
const { classifyEscalationWithAi } = require('./classifier/ai_escalation_classifier');
const { buildClientReport } = require('./reporting/client_report');

async function analyzeCompanyChanges(oldRecord, newRecord, options = {}) {
  const isDebug = process.env.DEBUG === 'true' || options.debug === true;

  // Step 1 & 2: Deterministic JSON Diff
  const diffResult = computeDeterministicDiff(oldRecord, newRecord, options);
  const company = diffResult.company;
  const rawChanges = diffResult.changes;

  if (rawChanges.length === 0) {
    const emptyResult = {
      company,
      evaluatedAt: new Date().toISOString(),
      summary: {
        totalChanges: 0,
        overallStatus: 'NO_CHANGES',
        finalAction: 'AUTO_ACCEPT',
        escalatedToAi: false
      },
      changes: []
    };
    return emptyResult;
  }

  // Step 3 & 4: Field-Type Classification + Field-Specific Signal Dispatch
  // Automatically normalizes empty values and filters out non-meaningful changes!
  const changesWithSignals = await extractAllSignalsForChanges(rawChanges, options);

  // Step 5: Rule-Based Importance-First Scoring
  const scoredFields = changesWithSignals.map(item => {
    const scored = scoreFieldSignals(item);
    return {
      path: item.path,
      fieldType: item.fieldType,
      changeType: item.comparisonType,
      importance: scored.importance,
      oldValue: item.rawValues?.old,
      newValue: item.rawValues?.new,
      score: scored.score,
      classification: scored.classification,
      action: scored.action,
      needsAiEscalation: scored.needsAiEscalation,
      escalationReasons: scored.escalationReasons,
      reason: scored.reason,
      signals: item.signals
    };
  });

  const companyEval = evaluateCompanyScores(scoredFields);

  // Structured Logging
  for (const item of scoredFields) {
    if (isDebug || item.needsAiEscalation || item.importance === 'CRITICAL' || item.importance === 'HIGH') {
      console.log(`[CHANGE] ${item.path.padEnd(20)} | [TYPE] ${item.fieldType.padEnd(10)} | [IMP] ${item.importance.padEnd(8)} | [ACT] ${item.action.padEnd(12)} | ${item.needsAiEscalation ? '[AI: ESCALATED]' : '[AI: NOT_REQUIRED]'}`);
    }
  }

  // Step 6: AI Escalation for Ambiguous Cases Only
  let aiEscalationResult = null;
  if (companyEval.itemsNeedingAi.length > 0 && !options.skipAi) {
    const escalationPayload = {
      company,
      escalatedFields: companyEval.itemsNeedingAi.map(item => ({
        path: item.path,
        fieldType: item.fieldType,
        importance: item.importance,
        oldValue: item.oldValue,
        newValue: item.newValue,
        escalationReasons: item.escalationReasons,
        signals: item.signals
      }))
    };

    aiEscalationResult = await classifyEscalationWithAi(escalationPayload);

    // Apply AI decisions to escalated fields
    for (const d of (aiEscalationResult?.decisions || [])) {
      const match = scoredFields.find(f => f.path === d.path);
      if (match) {
        match.action = d.action;
        match.classification = d.classification;
        match.reason = d.reasoning;
      }
    }
  }

  // Compute final action
  const finalAction = companyEval.criticalChangesCount > 0 || companyEval.highChangesCount > 0
    ? 'REVIEW'
    : (aiEscalationResult ? aiEscalationResult.overallVerdict : companyEval.overallStatus);

  // Step 7: Clean Internal Output
  const internalResult = {
    company,
    evaluatedAt: new Date().toISOString(),
    summary: {
      totalChanges: scoredFields.length,
      criticalChangesCount: companyEval.criticalChangesCount,
      highChangesCount: companyEval.highChangesCount,
      overallStatus: finalAction,
      finalAction,
      escalatedToAi: companyEval.itemsNeedingAi.length > 0,
      escalatedCount: companyEval.itemsNeedingAi.length
    },
    aiEscalation: aiEscalationResult,
    fieldEvaluations: scoredFields
  };

  // Build client-friendly report
  const clientReport = buildClientReport(internalResult);

  // Persist files
  const outDir = path.resolve(process.cwd(), 'results');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const domain = company.domain || 'analysis';
  const outPathInternal = path.join(outDir, `${domain}_signal_analysis.json`);
  const outPathClient = path.join(outDir, `${domain}_client_report.json`);

  fs.writeFileSync(outPathInternal, JSON.stringify(internalResult, null, 2), 'utf8');
  fs.writeFileSync(outPathClient, JSON.stringify(clientReport, null, 2), 'utf8');

  internalResult._filePath = outPathInternal;
  internalResult._clientReportPath = outPathClient;
  internalResult.clientReport = clientReport;

  return internalResult;
}

module.exports = {
  analyzeCompanyChanges,
  computeDeterministicDiff
};
