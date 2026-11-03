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

if security find-identity -p codesigning | grep -q "$NAME"; then
  echo "✓ Signing identity \"$NAME\" already present. Nothing to do."
  exit 0
fi

# A previous failed import can leave the certificate WITHOUT its private key (no usable identity).
# Remove any such leftover so this run's cert+key pair is the only "TabSolo Self-Signed" present,
# otherwise codesign sees two matching certs and the identity stays ambiguous/unusable.
while security find-certificate -c "$NAME" "$KEYCHAIN" >/dev/null 2>&1; do
  security delete-certificate -c "$NAME" "$KEYCHAIN" >/dev/null 2>&1 || break
done

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
# Non-empty transient password: an EMPTY PKCS#12 password makes `security import` fail with
# "MAC verification failed (wrong password?)" because LibreSSL and macOS disagree on the empty-
# password MAC. The .p12 is a temp file deleted on exit, so this password is throwaway.
P12_PW="tabsolo-signing-import"
openssl pkcs12 -export -out "$TMP/signing.p12" -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -passout "pass:$P12_PW" >/dev/null 2>&1

# -A lets codesign use the key without a per-build prompt. macOS will ask for your login password
# once here to modify the keychain — that is expected.
security import "$TMP/signing.p12" -k "$KEYCHAIN" -P "$P12_PW" -T /usr/bin/codesign -A

# Modern macOS also gates key use behind a partition list; set it so the build never prompts.
# Needs your login (keychain) password.
read -r -s -p "Login (keychain) password to finish authorizing codesign: " PW; echo
security set-key-partition-list -S apple-tool:,apple: -s -k "$PW" "$KEYCHAIN" >/dev/null 2>&1 || \
  echo "  (partition-list step skipped — the first build may show one codesign prompt; click Always Allow)"

echo
# Verify a USABLE identity (cert + its private key) actually landed — don't print a false success.
if ! security find-identity -p codesigning | grep -q "$NAME"; then
  echo "✗ Import did not produce a usable code-signing identity (cert present but no matching key)."
  echo "  Re-run this script; if it keeps failing, your 'security import' may be refusing the key."
  exit 1
fi
echo "✓ Imported \"$NAME\" (cert + private key)."
security find-identity -p codesigning | grep "$NAME"
echo
echo "Next:"
echo "  1. npm run dist:mac"
echo "  2. Drag TabSolo.app into /Applications (clears App Translocation)."
echo "  3. xattr -dr com.apple.quarantine /Applications/TabSolo.app"
echo "  4. Launch it and click \"Always Allow\" ONE more time (old key was under the ad-hoc identity)."
echo "     After that the keychain prompt should not return."
