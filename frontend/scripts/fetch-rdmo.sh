#!/usr/bin/env bash
# Fetch the prebuilt RDMO Digital Twin WebGL simulator (MIT, EdwinTSalcedo/RDMO-DigitalTwin)
# into public/rdmo/ so it can be embedded as a static iframe at /rdmo/index.html.
# Idempotent: skips work when public/rdmo/.rdmo-commit already matches the pinned SHA.
# Works without git-lfs: the big Unity files are LFS objects, fetched over HTTPS and
# checked against the sha256 in their LFS pointer. Nothing from the repo is executed.
#
# Env overrides: RDMO_WORK (clone directory, default: a temp dir), RDMO_FORCE=1 (refetch).
set -euo pipefail

REPO="EdwinTSalcedo/RDMO-DigitalTwin"
SHA="1152268834a4a1bac541867d4be463677c827e6f"
SRC_PATH="web/simulator-web"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$HERE/../public/rdmo"
STAMP="$DEST/.rdmo-commit"

if [[ "${RDMO_FORCE:-0}" != "1" && -f "$STAMP" && "$(cat "$STAMP")" == "$SHA" \
      && -s "$DEST/Build/simulator-web.wasm" && -s "$DEST/Build/simulator-web.data" ]]; then
  echo "rdmo: already at $SHA, nothing to do"
  exit 0
fi

if [[ -n "${RDMO_WORK:-}" ]]; then
  WORK="$RDMO_WORK"; mkdir -p "$WORK"
else
  WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
fi

echo "rdmo: shallow sparse fetch of $SRC_PATH at $SHA"
git -C "$WORK" init -q
git -C "$WORK" remote remove origin 2>/dev/null || true
git -C "$WORK" remote add origin "https://github.com/$REPO.git"
git -C "$WORK" sparse-checkout set --no-cone "/$SRC_PATH/" "/LICENSE.md"
git -C "$WORK" fetch -q --depth 1 --filter=blob:none origin "$SHA"
git -C "$WORK" -c filter.lfs.smudge= -c filter.lfs.process= -c filter.lfs.required=false \
  checkout -q FETCH_HEAD

SRC="$WORK/$SRC_PATH"
[[ -f "$SRC/index.html" ]] || { echo "rdmo: $SRC_PATH/index.html missing" >&2; exit 1; }

# Resolve Git LFS pointers by downloading the real objects and verifying their sha256.
while IFS= read -r -d '' f; do
  if [[ "$(head -c 200 "$f" | head -n 1)" == "version https://git-lfs.github.com/spec/v1" ]]; then
    oid="$(sed -n 's/^oid sha256://p' "$f")"
    size="$(sed -n 's/^size //p' "$f")"
    rel="${f#"$WORK"/}"
    echo "rdmo: lfs $rel ($size bytes)"
    curl -fsSL --retry 3 -o "$f.tmp" "https://media.githubusercontent.com/media/$REPO/$SHA/$rel"
    got="$(shasum -a 256 "$f.tmp" | cut -d' ' -f1)"
    [[ "$got" == "$oid" ]] || { echo "rdmo: sha256 mismatch for $rel" >&2; rm -f "$f.tmp"; exit 1; }
    mv "$f.tmp" "$f"
  fi
done < <(find "$SRC" -type f -print0)

# Fail loudly if any pointer is left unresolved.
if grep -rl --binary-files=without-match "^version https://git-lfs.github.com/spec/v1" "$SRC" >/dev/null 2>&1; then
  echo "rdmo: unresolved LFS pointer remains" >&2; exit 1
fi

rm -rf "$DEST"; mkdir -p "$DEST"
cp -R "$SRC/." "$DEST/"
rm -f "$DEST/start_server.bat"
cp "$WORK/LICENSE.md" "$DEST/LICENSE-RDMO.md"
echo "$SHA" > "$STAMP"
echo "rdmo: ready at public/rdmo (open /rdmo/index.html)"
