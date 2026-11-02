#!/usr/bin/env bash
set -euo pipefail

# Creates a STABLE self-signed code-signing identity for TabSolo and imports it into the login
# keychain, then rebuilds are signed with it instead of the ad-hoc "-" identity.
#
# Why: macOS binds a keychain "Always Allow" grant to the app's code signature. An ad-hoc signature
# has no stable anchor, so the "TabSolo Safe Storage" prompt comes back on every launch. A named
# self-signed cert is a stable anchor, so the grant sticks across launches and across rebuilds
# signed with the same cert. (It does NOT satisfy Gatekeeper/notarization — for that you need a paid
# Apple Developer ID. This only stops the repeated keychain prompt on machines that trust this cert.)
#
# Run once:  bash scripts/setup-mac-signing.sh
# Remove it: security delete-certificate -c "TabSolo Self-Signed" ~/Library/Keychains/login.keychain-db

NAME="TabSolo Self-Signed"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -v -p codesigning | grep -q "$NAME"; then
  echo "✓ Signing identity \"$NAME\" already present. Nothing to do."
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/csr.cnf" <<'CNF'
[ req ]
distinguished_name = dn
x509_extensions = v3
prompt = no
[ dn ]
CN = TabSolo Self-Signed
[ v3 ]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF

openssl req -x509 -newkey rsa:2048 -keyout "$TMP/key.pem" -out "$TMP/cert.pem" \
  -days 3650 -nodes -config "$TMP/csr.cnf" >/dev/null 2>&1
openssl pkcs12 -export -out "$TMP/signing.p12" -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -passout pass: >/dev/null 2>&1

# -A lets codesign use the key without a per-build prompt. macOS will ask for your login password
# once here to modify the keychain — that is expected.
security import "$TMP/signing.p12" -k "$KEYCHAIN" -P "" -T /usr/bin/codesign -A

# Modern macOS also gates key use behind a partition list; set it so the build never prompts.
# Needs your login (keychain) password.
read -r -s -p "Login (keychain) password to finish authorizing codesign: " PW; echo
security set-key-partition-list -S apple-tool:,apple: -s -k "$PW" "$KEYCHAIN" >/dev/null 2>&1 || \
  echo "  (partition-list step skipped — the first build may show one codesign prompt; click Always Allow)"

echo
echo "✓ Imported \"$NAME\"."
security find-identity -v -p codesigning | grep "$NAME" || true
echo
echo "Next:"
echo "  1. npm run dist:mac"
echo "  2. Drag TabSolo.app into /Applications (clears App Translocation)."
echo "  3. xattr -dr com.apple.quarantine /Applications/TabSolo.app"
echo "  4. Launch it and click \"Always Allow\" ONE more time (old key was under the ad-hoc identity)."
echo "     After that the keychain prompt should not return."
