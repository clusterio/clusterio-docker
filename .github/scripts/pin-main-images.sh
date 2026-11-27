#!/usr/bin/env bash
# Gives the images `main` published for one commit a second tag, without building anything.
# Run by .github/workflows/release-pin.yml when a revision pin tag is pushed.
#
#   pin-main-images.sh <tag> <commit sha> <image>...
#
# For every <image>, <image>:main must have been built from <commit sha> (its
# org.opencontainers.image.revision label). Nothing is tagged unless that holds for all of
# them. Each is then tagged <image>:<tag> by digest, and the new tag is read back: it must
# name the same digest. A <tag> that already names another image is refused.
set -euo pipefail

[ "$#" -ge 3 ] || { echo "usage: pin-main-images.sh <tag> <commit sha> <image>..." >&2; exit 2; }
TAG=$1 COMMIT=$2; shift 2
SOURCE_TAG=main
ERRORS=$(mktemp)
trap 'rm -f "$ERRORS"' EXIT

digest_of() { docker buildx imagetools inspect "$1" --format '{{.Manifest.Digest}}'; }
revision_of() { docker buildx imagetools inspect "$1" --format '{{index .Image.Config.Labels "org.opencontainers.image.revision"}}'; }

# The moving tag is resolved to a digest once; everything after reads and tags that digest.
# This first pass only reads. Every refusal is found here, before anything is tagged.
declare -a DIGESTS=() EXISTING=()
failed=0
for image in "$@"; do
  digest=$(digest_of "$image:$SOURCE_TAG") \
    || { echo "::error::Could not read $image:$SOURCE_TAG from the registry." >&2; exit 1; }
  case "$digest" in
    sha256:*) ;;
    *) echo "::error::$image:$SOURCE_TAG has no usable digest ('$digest')." >&2; exit 1;;
  esac
  revision=$(revision_of "$image@$digest") \
    || { echo "::error::Could not read the labels of $image@$digest." >&2; exit 1; }
  if [ "$revision" != "$COMMIT" ]; then
    echo "::error::$image:$SOURCE_TAG was built from commit '${revision:-unknown}', not from $COMMIT. A revision pin can only be cut from the commit ':$SOURCE_TAG' was last published from: tag that commit, or wait for this commit's main run to publish and run this job again." >&2
    failed=1
  fi
  # Only the registry's "not found" means the pin tag is free. Any other failure to read
  # it stops the run: an existing pin must not be replaced because it could not be read.
  if ! existing=$(digest_of "$image:$TAG" 2>"$ERRORS"); then
    if grep -qi "not found" "$ERRORS"; then
      existing=
    else
      cat "$ERRORS" >&2
      echo "::error::Could not tell whether $image:$TAG already exists." >&2
      exit 1
    fi
  fi
  if [ -n "$existing" ] && [ "$existing" != "$digest" ]; then
    echo "::error::$image:$TAG already names $existing. A pin is immutable: use the next .rN." >&2
    failed=1
  fi
  DIGESTS+=("$digest"); EXISTING+=("$existing")
done
[ "$failed" -eq 0 ] || exit 1

i=0
for image in "$@"; do
  digest=${DIGESTS[$i]} existing=${EXISTING[$i]}; i=$((i + 1))
  if [ "$existing" = "$digest" ]; then
    echo "$image:$TAG already names $digest"
    continue
  fi
  # --prefer-index=false makes this a copy of the manifest. Without it buildx wraps a
  # single image in a new index, and the tag would name a digest `main` never published.
  docker buildx imagetools create --prefer-index=false --tag "$image:$TAG" "$image@$digest" >&2
  pinned=$(digest_of "$image:$TAG")
  [ "$pinned" = "$digest" ] \
    || { echo "::error::$image:$TAG names $pinned after tagging; expected $digest." >&2; exit 1; }
  echo "$image:$TAG is $digest (commit $COMMIT, published from :$SOURCE_TAG)"
done
