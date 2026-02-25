#!/usr/bin/env node
/**
 * checksum utility
 * - Generate: node scripts/checksums.js            -> writes dist/checksums.txt
 * - Verify:   node scripts/checksums.js --verify   -> verifies dist/checksums.txt
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const distDir = path.resolve(__dirname, '..', 'dist');
const checksumFile = path.join(distDir, 'checksums.txt');

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(filePath);
  hash.update(data);
  return hash.digest('hex');
}

function gatherFiles() {
  if (!fs.existsSync(distDir)) {
    throw new Error('dist/ not found');
  }
  const allowed = [
    '.dmg',
    '.zip',
    '.exe',
    '.AppImage',
    '.deb',
    '.tar.gz',
    '.blockmap'
  ];
  return fs
    .readdirSync(distDir)
    .filter((f) => allowed.some((ext) => f.endsWith(ext)))
    .map((f) => path.join(distDir, f));
}

function generate() {
  const files = gatherFiles();
  if (files.length === 0) {
    console.log('No artifacts found to checksum.');
    return;
  }
  const lines = files.map((file) => `${sha256(file)}  ${path.basename(file)}`);
  fs.writeFileSync(checksumFile, lines.join('\n') + '\n');
  console.log(`Wrote ${lines.length} checksums to ${checksumFile}`);
}

function verify() {
  if (!fs.existsSync(checksumFile)) {
    throw new Error(`Missing ${checksumFile}. Run without --verify first.`);
  }
  const lines = fs
    .readFileSync(checksumFile, 'utf8')
    .split('\n')
    .filter(Boolean);

  let ok = 0;
  let failed = 0;

  for (const line of lines) {
    const [expected, filename] = line.split(/\s{2,}/);
    if (!expected || !filename) continue;
    const filePath = path.join(distDir, filename);
    if (!fs.existsSync(filePath)) {
      console.error(`Missing file: ${filename}`);
      failed++;
      continue;
    }
    const actual = sha256(filePath);
    if (actual === expected) {
      ok++;
    } else {
      console.error(`Checksum mismatch: ${filename}`);
      failed++;
    }
  }

  console.log(`Verified: ${ok} ok, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

if (process.argv.includes('--verify')) {
  verify();
} else {
  generate();
}
