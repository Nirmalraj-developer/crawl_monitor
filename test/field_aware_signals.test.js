/**
 * Unit Test Suite for Field-Aware Six-Signal Change Analyzer (test/field_aware_signals.test.js)
 * -----------------------------------------------------------------------------------------------
 * Verifies all mandatory requirements from section 22:
 * 1. Identity: White Studio <-> White Studio (no change) vs White Studio Bridal (meaningful change)
 * 2. Phone: 020 8368 1500 <-> 020-8368-1500 (same phone) vs 020 1234 5678 (phone changed)
 * 3. Email: INFO@example.com <-> info@example.com (same email) vs contact@example.com (changed)
 * 4. Location: London <-> Manchester (meaningful entity/location change)
 * 5. Text: We provide software for hospitals <-> healthcare organizations (semantically similar)
 * 6. Negation: We provide cloud hosting <-> We do not provide cloud hosting (important polarity change)
 * 7. Numbers: 28 years of experience <-> 15 years of experience (meaningful number change)
 * 8. URLs: ?id=12345 <-> ?id=67890 (must NOT become business number change)
 * 9. Empty Values: null <-> "" (no meaningful change)
 */

const assert = require('assert');
const { extractFieldSignals } = require('../src/signals');
const { areValuesEquivalent } = require('../src/normalization/normalizer');
const { getFieldConfig } = require('../src/config/field_analysis_config');
const { scoreFieldSignals } = require('../src/scoring/scoring_engine');

async function runTests() {
  console.log('--- Running Field-Aware Six-Signal Test Suite ---\n');

  // Test 1: Identity
  console.log('Test 1: Identity normalization & change detection');
  const idConfig = getFieldConfig('companyName');
  assert.strictEqual(areValuesEquivalent('White Studio', 'White Studio', idConfig), true, 'Same company name must be equivalent');
  assert.strictEqual(areValuesEquivalent('White Studio', 'White Studio Bridal', idConfig), false, 'Different company names must differ');

  const idSignal = await extractFieldSignals('White Studio', 'White Studio Bridal', 'companyName');
  assert.strictEqual(idSignal.fieldType, 'IDENTITY');
  assert.strictEqual(idSignal.signals.entity_changes.hasChanges, true);
  assert.strictEqual(idSignal.signals.embedding_semantic_similarity, undefined, 'Must NOT run embeddings on identity field');
  console.log('  ✓ Identity passed');

  // Test 2: Phone
  console.log('Test 2: Phone formatting normalization');
  const phoneConfig = getFieldConfig('phone');
  assert.strictEqual(areValuesEquivalent('020 8368 1500', '020-8368-1500', phoneConfig), true, 'Formatted phones must be equivalent');
  assert.strictEqual(areValuesEquivalent('020 8368 1500', '+44 20 8368 1500', phoneConfig), true, 'International prefix must match national');
  assert.strictEqual(areValuesEquivalent('020 8368 1500', '020 1234 5678', phoneConfig), false, 'Different numbers must differ');

  const phoneSignal = await extractFieldSignals('020 8368 1500', '020 1234 5678', 'phone');
  assert.strictEqual(phoneSignal.fieldType, 'CONTACT');
  assert.strictEqual(phoneSignal.signals.tfidf_cosine_similarity, undefined, 'Must NOT run TF-IDF on phone number');
  console.log('  ✓ Phone passed');

  // Test 3: Email
  console.log('Test 3: Email casing & normalization');
  const emailConfig = getFieldConfig('email');
  assert.strictEqual(areValuesEquivalent('INFO@example.com', 'info@example.com', emailConfig), true, 'Case-insensitive email match');
  assert.strictEqual(areValuesEquivalent('info@example.com', 'contact@example.com', emailConfig), false, 'Different email must differ');
  console.log('  ✓ Email passed');

  // Test 4: Location
  console.log('Test 4: Location entity change');
  const locSignal = await extractFieldSignals('London', 'Manchester', 'city');
  assert.strictEqual(locSignal.fieldType, 'LOCATION');
  assert.strictEqual(locSignal.signals.entity_changes.hasChanges, true);
  const scoredLoc = scoreFieldSignals(locSignal);
  assert.strictEqual(scoredLoc.action, 'REVIEW', 'Location shift must demand REVIEW');
  console.log('  ✓ Location passed');

  // Test 5: Text Semantic Similarity
  console.log('Test 5: Natural language semantic similarity');
  const textSignal = await extractFieldSignals(
    'We provide software for hospitals.',
    'We provide software for healthcare organizations.',
    'description'
  );
  assert.strictEqual(textSignal.fieldType, 'TEXT');
  assert.ok(textSignal.signals.embedding_semantic_similarity.similarity >= 0.70, 'Must recognize semantic similarity');
  console.log('  ✓ Text similarity passed');

  // Test 6: Negation & Polarity Flip
  console.log('Test 6: Negation reversal detection');
  const negSignal = await extractFieldSignals(
    'We provide cloud hosting.',
    'We do not provide cloud hosting.',
    'description'
  );
  assert.strictEqual(negSignal.signals.negation_changes.hasPolarityFlip, true, 'Must detect polarity flip');
  const scoredNeg = scoreFieldSignals(negSignal);
  assert.strictEqual(scoredNeg.needsAiEscalation, true, 'Polarity reversal must escalate to AI');
  console.log('  ✓ Negation passed');

  // Test 7: Business Number Change
  console.log('Test 7: Business number change in text');
  const numSignal = await extractFieldSignals(
    'We have 28 years of experience.',
    'We have 15 years of experience.',
    'description'
  );
  assert.strictEqual(numSignal.signals.number_changes.hasNumericDiscrepancy, true);
  assert.deepStrictEqual(numSignal.signals.number_changes.numbers.removed, ['28 years']);
  assert.deepStrictEqual(numSignal.signals.number_changes.numbers.added, ['15 years']);
  console.log('  ✓ Number change passed');

  // Test 8: URL Parameter Filtering (NO fake number change)
  console.log('Test 8: URLs with IDs must not trigger business number changes');
  const urlSignal = await extractFieldSignals(
    'https://example.com?id=12345&timestamp=1703063255116',
    'https://example.com?id=67890&timestamp=1703063255999',
    'website'
  );
  assert.strictEqual(urlSignal.fieldType, 'URL');
  assert.strictEqual(urlSignal.signals?.number_changes, undefined, 'URL must not trigger number changes');
  console.log('  ✓ URL parameter filtering passed');

  // Test 9: Null & Empty String Equivalence
  console.log('Test 9: null <-> "" must be treated as NO_MEANINGFUL_CHANGE');
  const emptyConfig = getFieldConfig('socialLinks.facebook');
  assert.strictEqual(areValuesEquivalent(null, '', emptyConfig), true);
  assert.strictEqual(areValuesEquivalent(null, '   ', emptyConfig), true);
  assert.strictEqual(areValuesEquivalent('', undefined, emptyConfig), true);

  const emptySignal = await extractFieldSignals(null, '', 'socialLinks.facebook');
  assert.strictEqual(emptySignal.isEquivalent, true, 'Empty transition must be flagged as equivalent');
  console.log('  ✓ Empty values passed');

  console.log('\nAll 9 / 9 Field-Aware Signal Tests PASSED successfully!\n');
}

runTests().catch(err => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});

