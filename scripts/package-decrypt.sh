#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist_decrypt"
BIN_PROXY="$ROOT/pqc-proxy/target/release/pqc-proxy"
BIN_DECRYPT="$ROOT/pqc-proxy/target/release/decrypt"
CLI="$ROOT/scripts/decrypt-cli.js"

if [[ ! -x "$BIN_PROXY" || ! -x "$BIN_DECRYPT" ]]; then
  echo "Building pqc-proxy (release)…"
  (cd "$ROOT/pqc-proxy" && cargo build --release)
fi

rm -rf "$DIST"
mkdir -p "$DIST"
cp "$BIN_PROXY" "$BIN_DECRYPT" "$CLI" "$DIST"/
cat > "$DIST/README.txt" <<'TXT'
Decrypt Kit (PQC)
-----------------
Files:
- pqc-proxy           : Kyber/Dilithium service (listens on 127.0.0.1:8787)
- decrypt             : Rust CLI decryptor
- decrypt-cli.js      : Node wrapper; starts proxy if needed

Usage (simple):
  node decrypt-cli.js --envelope /path/to/pqc-envelope.json --keys /path/to/keys.json

Usage (Rust CLI direct):
  ./decrypt /path/to/pqc-envelope.json /path/to/keys.json

Notes:
- keys.json must include at least "kem_secret" (Kyber secret key base64).
- Proxy default port: 8787. Override with env PQC_PROXY_PORT or --port for JS CLI.
TXT

zip -r "$ROOT/dist/decrypt-kit.zip" -j "$DIST" >/dev/null
echo "Decrypt kit packaged at dist/decrypt-kit.zip"
