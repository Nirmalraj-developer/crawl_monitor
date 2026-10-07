#!/usr/bin/env node
/**
 * CLI Runner for Six-Signal Change Analysis (analyze_changes.js)
 * ----------------------------------------------------------------
 * Supports:
 *   node analyze_changes.js <old.json> <new.json> [--debug]
 *   node analyze_changes.js --domain <domain> [--debug]
 */

const fs = require('fs');
const path = require('path');
const { analyzeCompanyChanges } = require('./src');

async function main() {
  const args = process.argv.slice(2);
  const isDebug = args.includes('--debug');

  let oldPath = null;
  let newPath = null;
  let domain = null;

  const domainIdx = args.indexOf('--domain');
  if (domainIdx !== -1 && args[domainIdx + 1]) {
    domain = args[domainIdx + 1].trim();
    oldPath = path.resolve(process.cwd(), 'data', 'old', `${domain}.json`);
    newPath = path.resolve(process.cwd(), 'data', 'new', `${domain}.json`);
  } else {
    const fileArgs = args.filter(a => !a.startsWith('--'));
    if (fileArgs.length >= 2) {
      oldPath = path.resolve(process.cwd(), fileArgs[0]);
      newPath = path.resolve(process.cwd(), fileArgs[1]);
    }
  }

  if (!oldPath || !newPath) {
    console.log(`
Usage:
  node analyze_changes.js <old.json> <new.json> [--debug]
  node analyze_changes.js --domain <domain> [--debug]

Example:
  node analyze_changes.js data/old/whitestudiolondon.com.json data/new/whitestudiolondon.com.json
  node analyze_changes.js --domain whitestudiolondon.com
    `);
    process.exit(1);
  }

  if (!fs.existsSync(oldPath)) {
    console.error(`Error: File not found: ${oldPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(newPath)) {
    console.error(`Error: File not found: ${newPath}`);
    process.exit(1);
  }

  const oldJson = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
  const newJson = JSON.parse(fs.readFileSync(newPath, 'utf8'));

  console.log('\n========================================================================================');
  console.log(' FIELD-AWARE SIX-SIGNAL COMPANY CHANGE ANALYZER');
  console.log('========================================================================================');
  console.log(`Old Record: ${oldPath}`);
  console.log(`New Record: ${newPath}`);
  console.log('----------------------------------------------------------------------------------------');

  const result = await analyzeCompanyChanges(oldJson, newJson, { debug: isDebug });
  const clientRep = result.clientReport;

  console.log(`\nCompany: ${clientRep.company} (${clientRep.domain})`);
  console.log(`Overall Status: [${clientRep.overallStatus}]`);
  console.log(`Summary:        ${clientRep.summary}`);
  console.log(`Total Meaningful Changes: ${clientRep.totalChanges}`);
  console.log(`AI Escalation:  ${result.summary.escalatedToAi ? 'YES (' + result.summary.escalatedCount + ' ambiguous field(s))' : 'NO'}`);
  console.log('----------------------------------------------------------------------------------------');

  console.log('CLIENT-FRIENDLY BUSINESS CHANGES:');
  for (const ch of clientRep.changes.slice(0, 10)) {
    console.log(` • [${ch.importance}] ${ch.field}: ${ch.reason}`);
    if (isDebug) {
      console.log(`   - Previous: ${JSON.stringify(ch.previous)?.slice(0, 60)}`);
      console.log(`   - Current:  ${JSON.stringify(ch.current)?.slice(0, 60)}`);
    }
  }

  if (clientRep.changes.length > 10) {
    console.log(`   ... and ${clientRep.changes.length - 10} more change(s).`);
  }

  console.log('========================================================================================');
  console.log(`Client Report JSON:  ${result._clientReportPath}`);
  console.log(`Developer Full JSON: ${result._filePath}\n`);
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal Error:', err);
    process.exit(1);
  });
}
