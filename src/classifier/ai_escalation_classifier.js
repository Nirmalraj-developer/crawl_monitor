/**
 * AI Escalation & Final Decision Classifier (src/classifier/ai_escalation_classifier.js)
 * ----------------------------------------------------------------------------------------
 * Receives ONLY the structured signal results and identity for ambiguous / high-impact changes.
 * Calls OpenAI (or Gemini / local fallback) to produce a definitive business change verdict:
 * - AUTO_ACCEPT
 * - REVIEW
 * - IGNORE
 */

const fs = require('fs');
const path = require('path');

// Auto-load .env
function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [k, ...v] = trimmed.split('=');
    const key = k.trim();
    const val = v.join('=').trim().replace(/^['"]|['"]$/g, '');
    if (!process.env[key] && val) {
      process.env[key] = val;
    }
  }
}
loadEnv();

const AI_CLASSIFICATION_PROMPT = `You are an expert Company Change Auditor and Business Verification AI.

You have received an escalation containing structured analysis from 6 independent signals:
1. Entity Changes (phones, emails, registrations)
2. Embedding Semantic Similarity (conceptual meaning)
3. TF-IDF + Cosine Similarity (keyword distinctiveness)
4. Jaccard Similarity (lexical overlap)
5. Number Changes (financials, dates, metrics)
6. Negation Changes (polarity reversals)

Your job is NOT to calculate differences.
Your job is to analyze the structured signal findings for the ambiguous / high-impact changed fields and make a definitive business decision.

Classify each escalated change into:
- ENRICHMENT (newly discovered data)
- CORRECTION (fixing wrong data or updating contact details)
- BUSINESS_CHANGE (rebranding, relocation, change in activity, merger, shutdown)
- CONTENT_UPDATE (editorial, marketing, minor rewording)
- STRUCTURAL_CHANGE (site navigation, routing)
- NOISE (telemetry, session params)

Determine final action for each:
- AUTO_ACCEPT
- REVIEW
- IGNORE

Return JSON only in this format:
{
  "escalationSummary": "<string>",
  "overallVerdict": "AUTO_ACCEPT|REVIEW|IGNORE",
  "overallConfidence": <number 0.0 - 1.0>,
  "decisions": [
    {
      "path": "<string>",
      "classification": "ENRICHMENT|CORRECTION|BUSINESS_CHANGE|CONTENT_UPDATE|STRUCTURAL_CHANGE|NOISE",
      "action": "AUTO_ACCEPT|REVIEW|IGNORE",
      "confidence": <number 0.0 - 1.0>,
      "reasoning": "<string based on the 6 signal metrics>"
    }
  ]
}`;

class HeuristicFallbackClassifier {
  classify(escalationPayload) {
    const decisions = (escalationPayload.escalatedFields || []).map(item => {
      const p = item.path || '';
      const score = item.score || 0;
      const reasons = item.escalationReasons || [];
      const hasPolarity = reasons.some(r => r.includes('polarity') || r.includes('Negation'));
      const hasCriticalEntity = reasons.some(r => r.includes('Critical entity'));

      let classification = 'CONTENT_UPDATE';
      let action = 'REVIEW';
      let confidence = 0.88;
      let reasoning = reasons.join('; ') || 'Escalated based on score threshold.';

      if (hasPolarity) {
        classification = 'BUSINESS_CHANGE';
        action = 'REVIEW';
        confidence = 0.94;
        reasoning = 'Polarity reversal detected; changes core business operational state.';
      } else if (hasCriticalEntity || item.importance === 'HIGH') {
        classification = item.changeType === 'ADDED' ? 'ENRICHMENT' : 'CORRECTION';
        action = item.changeType === 'ADDED' ? 'AUTO_ACCEPT' : 'REVIEW';
        confidence = 0.92;
        reasoning = `High-importance entity change (${item.changeType}) on "${p}".`;
      } else if (score < 30) {
        classification = 'CONTENT_UPDATE';
        action = 'AUTO_ACCEPT';
        confidence = 0.85;
      }

      return {
        path: p,
        classification,
        action,
        confidence,
        reasoning
      };
    });

    const anyReview = decisions.some(d => d.action === 'REVIEW');

    return {
      escalationSummary: `Processed ${decisions.length} escalated field(s) via signal arbitration.`,
      overallVerdict: anyReview ? 'REVIEW' : 'AUTO_ACCEPT',
      overallConfidence: 0.91,
      decisions
    };
  }
}

async function classifyEscalationWithAi(escalationPayload) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (apiKey) {
    try {
      const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
      const requestBody = {
        model,
        messages: [
          { role: 'system', content: AI_CLASSIFICATION_PROMPT },
          { role: 'user', content: JSON.stringify(escalationPayload, null, 2) }
        ],
        response_format: { type: 'json_object' },
        temperature: 0.0
      };

      console.log('\n========================================================================================');
      console.log(`[OpenAI ESCALATION REQUEST] Model: ${model}`);
      console.log('----------------------------------------------------------------------------------------');
      console.log('[Structured Signals Payload Sent to AI]');
      console.log(JSON.stringify(escalationPayload, null, 2));
      console.log('========================================================================================\n');

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`[OpenAI Error (${response.status})]: ${errText}`);
        throw new Error(`OpenAI request failed: ${errText}`);
      }

      const data = await response.json();
      const rawText = data.choices[0].message.content;

      console.log('\n========================================================================================');
      console.log('[OpenAI ESCALATION RESPONSE RECEIVED]');
      console.log('----------------------------------------------------------------------------------------');
      console.log(rawText);
      console.log('========================================================================================\n');

      return JSON.parse(rawText);
    } catch (err) {
      console.warn(`[AI Classifier Warning] OpenAI invocation failed (${err.message}). Falling back to signal heuristic arbitrator.`);
    }
  }

  // Fallback to local deterministic signal arbitrator
  const fallback = new HeuristicFallbackClassifier();
  return fallback.classify(escalationPayload);
}

module.exports = {
  classifyEscalationWithAi,
  HeuristicFallbackClassifier
};

