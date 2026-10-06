#!/usr/bin/env bash
# Build the signed release APK for the Solana dApp Store, and check it before it is uploaded.
#
#   android/release.sh --new-key   first time only: makes the signing key, then builds
#   android/release.sh             every release after that
#
# Needs JDK 21 and an Android SDK with platforms;android-37.0 and build-tools;37.0.0
# (ANDROID_HOME). The key lives at .secrets/dappstore.keystore (git-ignored); override with
# KEYSTORE=<path> and KEY_ALIAS=<alias>. Passwords come from SOLANA_MOBILE_KEYSTORE_PASSWORD and
# SOLANA_MOBILE_KEY_PASSWORD, or are asked for and never written anywhere.
#
# The store knows an app by its signing certificate, and every update must carry the same one.
# The certificate's SHA-256 is recorded in android/dappstore-cert.sha256 (a public fingerprint,
# safe to commit) the first time, and a build signed by any other key is refused afterwards.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
new_key=0
for arg in "$@"; do
  case "$arg" in
    --new-key) new_key=1 ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

die() { echo "release: $*" >&2; exit 1; }

sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
[ -n "$sdk" ] || die "set ANDROID_HOME to the Android SDK (docs/DAPP_STORE.md section 2)"
tools="$sdk/build-tools/37.0.0"
[ -x "$tools/apksigner" ] || die "build-tools 37.0.0 not found under $sdk"
java -version 2>&1 | grep -q 'version "21' || die "JDK 21 is required (java -version)"

keystore="${KEYSTORE:-$root/.secrets/dappstore.keystore}"
case "$keystore" in /*) ;; *) keystore="$PWD/$keystore" ;; esac
alias="${KEY_ALIAS:-beachbingo}"
pinned="$here/dappstore-cert.sha256"

if [ ! -f "$keystore" ]; then
  [ "$new_key" = 1 ] || die "no key at $keystore. First release: run with --new-key. Otherwise restore the key from its backup: a new key cannot update a published app."
  [ ! -f "$pinned" ] || die "android/dappstore-cert.sha256 already names a published key; restore that key from its backup instead of making a new one."
fi
if [ "$new_key" = 1 ] && [ -f "$keystore" ]; then
  die "$keystore already exists; it is the key. Run without --new-key."
fi

ask() { # ask VAR "prompt": read a secret into VAR unless the environment already has it
  local var="$1" prompt="$2" value
  if [ -z "${!var:-}" ]; then
    read -r -s -p "$prompt: " value; echo
    [ -n "$value" ] || die "$prompt cannot be empty"
    export "$var=$value"
  fi
}
ask SOLANA_MOBILE_KEYSTORE_PASSWORD "Keystore password"
if [ "$new_key" = 1 ]; then
  [ "${#SOLANA_MOBILE_KEYSTORE_PASSWORD}" -ge 6 ] || die "the keystore password needs at least 6 characters"
  confirm="${SOLANA_MOBILE_KEYSTORE_PASSWORD_CONFIRM:-}"
  [ -n "$confirm" ] || { read -r -s -p "Keystore password again: " confirm; echo; }
  [ "$confirm" = "$SOLANA_MOBILE_KEYSTORE_PASSWORD" ] || die "the two passwords differ"
fi
# One password for the store and the key unless a separate key password is set.
export SOLANA_MOBILE_KEY_PASSWORD="${SOLANA_MOBILE_KEY_PASSWORD:-$SOLANA_MOBILE_KEYSTORE_PASSWORD}"

if [ "$new_key" = 1 ]; then
  dname="${KEY_DNAME:-}"
  if [ -z "$dname" ]; then
    read -r -p "Publisher's legal name for the certificate (e.g. Example Games LLC): " org
    [ -n "$org" ] || die "the certificate needs a name"
    dname="CN=Beach Bingo, O=${org//,/\\,}, C=US"
  fi
  mkdir -p "$(dirname "$keystore")"
  chmod 700 "$(dirname "$keystore")"
  keytool -genkeypair -keystore "$keystore" -storetype PKCS12 -alias "$alias" \
    -keyalg RSA -keysize 2048 -validity 10000 -dname "$dname" \
    -storepass:env SOLANA_MOBILE_KEYSTORE_PASSWORD -keypass:env SOLANA_MOBILE_KEY_PASSWORD >/dev/null
  chmod 600 "$keystore"
  echo "Made the signing key: $keystore"
fi

keytool -list -keystore "$keystore" -alias "$alias" -storepass:env SOLANA_MOBILE_KEYSTORE_PASSWORD >/dev/null 2>&1 \
  || die "cannot open alias '$alias' in $keystore with that password"

echo "Building the release…"
(cd "$here" && ANDROID_HOME="$sdk" ./gradlew --quiet assembleRelease \
  -PSOLANA_MOBILE_KEYSTORE_PATH="$keystore" -PSOLANA_MOBILE_KEYSTORE_ALIAS="$alias")

apk="$here/app/build/outputs/apk/release/app-release.apk"
[ -f "$apk" ] || die "no signed APK at $apk (an unsigned build means the signing settings did not reach Gradle)"

certs="$("$tools/apksigner" verify --verbose --print-certs "$apk")" || die "apksigner rejected $apk"
grep -q "Verified using v2 scheme (APK Signature Scheme v2): true" <<<"$certs" || die "the APK is not signed with APK Signature Scheme v2"
grep -qx "Number of signers: 1" <<<"$certs" || die "the APK must have exactly one signer"
# apksigner labels the signer "Signer #1" or by scheme ("V2 Signer"), depending on its version.
digest="$(sed -n -E '0,/^(Signer #1|V[0-9.]+ Signer):? certificate SHA-256 digest: /s///p' <<<"$certs")"
[ -n "$digest" ] || die "could not read the signing certificate from $apk"
subject="$(sed -n -E '0,/^(Signer #1|V[0-9.]+ Signer):? certificate DN: /s///p' <<<"$certs")"
case "$subject" in *"Android Debug"*) die "the APK is signed with the debug key" ;; esac

if [ -f "$pinned" ]; then
  [ "$(tr -d ' \n' <"$pinned")" = "$digest" ] || die "signed with $digest, but the published app's key is $(cat "$pinned"). The store would refuse this update."
else
  echo "$digest" >"$pinned"
  echo "Recorded the certificate in android/dappstore-cert.sha256; commit it."
fi

badging="$("$tools/aapt2" dump badging "$apk")"
badging="${badging%%$'\n'*}"
echo
echo "Signed:   $apk"
echo "Package:  $badging"
echo "Signer:   $subject"
echo "Cert:     $digest"
echo "SHA-256:  $(sha256sum "$apk" | cut -d' ' -f1)"
echo "Size:     $(du -h "$apk" | cut -f1)"
if [ "$new_key" = 1 ]; then
  echo
  echo "Back up $keystore and its password now, in two places. Lose either and the app can never be updated."
fi
