#!/usr/bin/env node
// Simple CLI decryptor using pqc-proxy /decrypt endpoint.
// Usage: npm run decrypt -- --envelope path/to/pqc-envelope.json --keys path/to/keys.json [--port 8787]

const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const args = require('minimist')(process.argv.slice(2));
const envelopePath = args.envelope || args.e;
const keysPath = args.keys || args.k;
const port = Number(args.port || process.env.PQC_PROXY_PORT || 8787);
const proxyBin = path.join(__dirname, '..', 'pqc-proxy', 'target', 'release', 'pqc-proxy');

if (!envelopePath || !keysPath) {
  console.error('Usage: node scripts/decrypt-cli.js --envelope FILE --keys FILE [--port 8787]');
  process.exit(1);
}

function fileExists(p) {
  try { fs.accessSync(p, fs.constants.R_OK); return true; } catch { return false; }
}

if (!fileExists(envelopePath)) {
  console.error(`Envelope not found: ${envelopePath}`);
  process.exit(1);
}
if (!fileExists(keysPath)) {
  console.error(`Keys not found: ${keysPath}`);
  process.exit(1);
}

let proxyProcess = null;
function ensureProxy() {
  return new Promise((resolve, reject) => {
    // quick health check
    const req = http.get({ hostname: '127.0.0.1', port, path: '/health', timeout: 400 }, (res) => {
      res.destroy();
      resolve();
    });
    req.on('error', () => {
      // start proxy
      if (!fileExists(proxyBin)) {
        reject(new Error(`pqc-proxy binary not found at ${proxyBin}. Build it first (cargo build --release).`));
        return;
      }
      proxyProcess = spawn(proxyBin, { env: { ...process.env, PQC_PROXY_PORT: String(port) }, stdio: 'ignore' });
      setTimeout(resolve, 600); // give it a moment to boot
    });
  });
}

async function main() {
  await ensureProxy();
  const envelope = JSON.parse(fs.readFileSync(envelopePath, 'utf8'));
  const keys = JSON.parse(fs.readFileSync(keysPath, 'utf8'));

  const payload = JSON.stringify({ envelope, kem_secret: keys.kem_secret });

  const res = await fetch(`http://127.0.0.1:${port}/decrypt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload
  });
  if (!res.ok) {
    throw new Error(`Decrypt failed: ${res.status}`);
  }
  const data = await res.json();
  console.log('--- DECRYPTED ---');
  console.log(`Verified signature: ${data.verified}`);
  console.log(`Signer (Dilithium public): ${data.signer_public}`);
  console.log('Plaintext:\n');
  console.log(data.plaintext);
}

main().catch((err) => {
  console.error('❌', err.message || err);
  process.exit(1);
}).finally(() => {
  // allow proxy to keep running for reuse; caller can kill if desired
});
