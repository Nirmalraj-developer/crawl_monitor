/**
 * Unit Tests for field_scorer.js
 */
const assert = require('assert');
const {
  scoreCompanyChanges,
  scoreCompanyName,
  scoreDescription,
  scorePhone,
  scoreEmail,
  scoreAddress,
  scoreTitle,
  scoreUrl,
} = require('./field_scorer');

console.log('--- Running field_scorer.js Unit Tests ---');

// 1. Company Name
assert.strictEqual(scoreCompanyName('Acme Corp', 'Acme Corp').status, 'UNCHANGED');
assert.strictEqual(scoreCompanyName('Acme Corp', 'Acme Corp').score, 0);

assert.strictEqual(scoreCompanyName('Acme Corp', 'Beta Ltd').status, 'MODIFIED');
assert.strictEqual(scoreCompanyName('Acme Corp', 'Beta Ltd').score, 25);

assert.strictEqual(scoreCompanyName('Acme Corp', null).status, 'NOT_FOUND_IN_CRAWL');
assert.strictEqual(scoreCompanyName('Acme Corp', null).score, 10);

assert.strictEqual(scoreCompanyName(null, 'Acme Corp').status, 'ADDED');
assert.strictEqual(scoreCompanyName(null, 'Acme Corp').score, 5);

console.log('[PASS] company_name scoring');

// 2. Description
const descA = 'Leading cloud computing provider offering enterprise Kubernetes services worldwide.';
const descIdentical = 'Leading cloud computing provider offering enterprise Kubernetes services worldwide.';
const descMinor = 'Leading cloud computing provider offering managed Kubernetes clusters worldwide.';
const descMajor = 'We sell handmade wedding dresses and bridal jewelry in London.';

assert.strictEqual(scoreDescription(descA, descIdentical).status, 'UNCHANGED');
assert.strictEqual(scoreDescription(descA, descIdentical).score, 0);

assert.strictEqual(scoreDescription(descA, descMinor).status, 'MINOR_UPDATE');
assert.strictEqual(scoreDescription(descA, descMinor).score, 5);

assert.strictEqual(scoreDescription(descA, descMajor).status, 'MAJOR_CHANGE');
assert.strictEqual(scoreDescription(descA, descMajor).score, 20);

assert.strictEqual(scoreDescription(descA, null).status, 'NOT_FOUND_IN_CRAWL');
assert.strictEqual(scoreDescription(descA, null).score, 10);

console.log('[PASS] description scoring');

// 3. Phone
assert.strictEqual(scorePhone('020 8368 1500', '+44 20 8368 1500').status, 'UNCHANGED');
assert.strictEqual(scorePhone('020 8368 1500', '020 8368 1500').score, 0);

assert.strictEqual(scorePhone('020 8368 1500', '020 9999 8888').status, 'MODIFIED');
assert.strictEqual(scorePhone('020 8368 1500', '020 9999 8888').score, 15);

assert.strictEqual(scorePhone('020 8368 1500', null).status, 'NOT_FOUND_IN_CRAWL');
assert.strictEqual(scorePhone('020 8368 1500', null).score, 5);

console.log('[PASS] phone scoring');

// 4. Email
assert.strictEqual(scoreEmail('info@acme.com', 'INFO@ACME.COM').status, 'UNCHANGED');
assert.strictEqual(scoreEmail('info@acme.com', 'contact@acme.com').status, 'MODIFIED');
assert.strictEqual(scoreEmail('info@acme.com', 'contact@acme.com').score, 15);
assert.strictEqual(scoreEmail('info@acme.com', null).status, 'NOT_FOUND_IN_CRAWL');

console.log('[PASS] email scoring');

// 5. Website Redirection
assert.strictEqual(scoreUrl('https://acme.com', 'https://www.acme.com/').status, 'UNCHANGED');
assert.strictEqual(scoreUrl('https://acme.com', 'https://otherbrand.com/').status, 'REDIRECTED');
assert.strictEqual(scoreUrl('https://acme.com', 'https://otherbrand.com/').score, 20);

console.log('[PASS] website / url scoring');

// 6. Overall Company Score Integration
const resUnchanged = scoreCompanyChanges(
  { companyName: 'Acme', description: descA, phone: '12345', email: 'a@a.com', url: 'https://acme.com' },
  { companyName: 'Acme', description: descA, phone: '12345', email: 'a@a.com', url: 'https://acme.com' }
);
assert.strictEqual(resUnchanged.total_change_score, 0);
assert.strictEqual(resUnchanged.change_level, 'LOW');
assert.strictEqual(resUnchanged.has_meaningful_change, false);

const resMajor = scoreCompanyChanges(
  { companyName: 'Acme', description: descA, phone: '12345', email: 'a@a.com', url: 'https://acme.com' },
  { companyName: 'NewBrand', description: descMajor, phone: '99999', email: 'b@b.com', url: 'https://newbrand.com' }
);
assert.ok(resMajor.total_change_score >= 80);
assert.strictEqual(resMajor.change_level, 'HIGH');
assert.strictEqual(resMajor.has_meaningful_change, true);

console.log('[PASS] full company score integration');
console.log('\nAll field_scorer unit tests passed successfully!\n');
