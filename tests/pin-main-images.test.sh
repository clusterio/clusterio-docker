#!/bin/bash
# Stubbed, no Docker and no registry: .github/scripts/pin-main-images.sh against a fake
# `docker buildx imagetools` that keeps tags and labels in files. Covers which images get a
# pin tag and when nothing may be tagged. That the real `imagetools create
# --prefer-index=false` keeps the digest is not something a stub can show; the script's
# read-back check is what fails a run where it does not (case 6 simulates that).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"
export STATE="$WORK/state"
cat > "$WORK/bin/docker" <<'SH'
#!/bin/bash
key() { printf '%s' "$1" | tr '/:@' '___'; }
[ "$1 $2" = "buildx imagetools" ] || { echo "unexpected docker call: $*" >&2; exit 64; }
case "$3" in
  inspect)
    ref=$4 format=$6
    if [ "$ref" = "${STUB_UNREADABLE:-}" ]; then echo "ERROR: $ref: unexpected status 503" >&2; exit 1; fi
    case "$ref" in
      *@*) digest=${ref#*@};;
      *) [ -f "$STATE/$(key "$ref")" ] || { echo "ERROR: $ref: not found" >&2; exit 1; }
         digest=$(cat "$STATE/$(key "$ref")");;
    esac
    case "$format" in
      *Digest*) echo "$digest";;
      *revision*) cat "$STATE/revision_${digest#sha256:}";;
      *) echo "unexpected format: $format" >&2; exit 64;;
    esac;;
  create)
    [ "$4" = "--prefer-index=false" ] && [ "$5" = "--tag" ] || { echo "unexpected create call: $*" >&2; exit 64; }
    digest=${7#*@}
    # A buildx that wraps the image in an index gives the tag a digest of its own.
    if [ -n "${STUB_WRAPS_IN_INDEX:-}" ]; then digest=sha256:wrapped; fi
    echo "$digest" > "$STATE/$(key "$6")"
    echo "$6" >> "$STATE/created";;
  *) echo "unexpected docker call: $*" >&2; exit 64;;
esac
SH
chmod +x "$WORK/bin/docker"
export PATH="$WORK/bin:$PATH"

A=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa B=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
C=registry.test/x-controller H=registry.test/x-host
key() { printf '%s' "$1" | tr '/:@' '___'; }
# publish <image> <digest> <commit>: what a main run leaves in the registry.
publish() { echo "sha256:$2" > "$STATE/$(key "$1:main")"; echo "$3" > "$STATE/revision_$2"; }
reset() { rm -rf "$STATE"; mkdir -p "$STATE"; : > "$STATE/created"; publish "$C" c1 "$A"; publish "$H" h1 "$A"; }
tag_of() { cat "$STATE/$(key "$1")" 2>/dev/null || true; }
created() { wc -l < "$STATE/created" | tr -d ' '; }
pin() { bash "$REPO_ROOT/.github/scripts/pin-main-images.sh" "$@" > "$WORK/out" 2> "$WORK/err"; }
fail() { echo "FAIL: $1"; cat "$WORK/out" "$WORK/err"; exit 1; }

echo "1: both images built from the tagged commit get the pin tag, by digest"
reset
pin 9.9.9.r1 "$A" "$C" "$H" || fail "the pin was refused"
[ "$(tag_of "$C:9.9.9.r1")" = sha256:c1 ] && [ "$(tag_of "$H:9.9.9.r1")" = sha256:h1 ] || fail "the pin tags do not name main's digests"

echo "2: running it again changes nothing"
pin 9.9.9.r1 "$A" "$C" "$H" || fail "a second run was refused"
[ "$(created)" = 2 ] || fail "a second run tagged again"

echo "3: main was built from another commit: nothing is tagged"
reset
if pin 9.9.9.r1 "$B" "$C" "$H"; then fail "a pin of a commit main was not built from was accepted"; fi
[ "$(created)" = 0 ] || fail "something was tagged"
grep -q "was built from commit '$A', not from $B" "$WORK/err" || fail "the error does not name both commits"

echo "4: only one image is from the tagged commit: neither is tagged"
reset; publish "$H" h2 "$B"
if pin 9.9.9.r1 "$A" "$C" "$H"; then fail "a half-published commit was pinned"; fi
[ "$(created)" = 0 ] || fail "the controller was tagged although the host was refused"

echo "5: the pin tag already names another image: refused"
reset
pin 9.9.9.r1 "$A" "$C" "$H" || fail "the pin was refused"
publish "$C" c2 "$B"; publish "$H" h2 "$B"
if pin 9.9.9.r1 "$B" "$C" "$H"; then fail "an existing pin was moved"; fi
[ "$(tag_of "$C:9.9.9.r1")" = sha256:c1 ] || fail "the existing pin changed"
grep -q "A pin is immutable" "$WORK/err" || fail "the error does not say why"

echo "5b: only the host's pin tag names another image: the controller is not tagged either"
reset; echo sha256:other > "$STATE/$(key "$H:9.9.9.r1")"
if pin 9.9.9.r1 "$A" "$C" "$H"; then fail "a pin that names another host image was accepted"; fi
[ "$(created)" = 0 ] || fail "the controller was tagged although the host pin was refused"

echo "5c: the pin tag cannot be read for another reason than being absent: nothing is tagged"
reset
if STUB_UNREADABLE="$H:9.9.9.r1" pin 9.9.9.r1 "$A" "$C" "$H"; then fail "an unreadable pin tag was taken as free"; fi
[ "$(created)" = 0 ] || fail "something was tagged although a pin tag could not be read"
grep -q "Could not tell whether $H:9.9.9.r1 already exists" "$WORK/err" || fail "the error does not name the unreadable tag"

echo "6: a tag that names another digest after tagging fails the run"
reset
if STUB_WRAPS_IN_INDEX=1 pin 9.9.9.r1 "$A" "$C" "$H"; then fail "a changed digest was accepted"; fi
grep -q "after tagging; expected sha256:c1" "$WORK/err" || fail "the read-back check did not report the digest"

echo "7: an image main never published: refused"
reset
if pin 9.9.9.r1 "$A" "$C" registry.test/x-missing; then fail "a missing image was accepted"; fi
[ "$(created)" = 0 ] || fail "something was tagged"

echo "PASS: pin-main-images"
