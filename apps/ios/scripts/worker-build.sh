#!/usr/bin/env bash
set -euo pipefail

# Shared iOS build helper for parallel workers. Every worker on a branch
# family reuses one derived-data directory instead of its own copy, and test
# result bundles are exported and reclaimed so a fan-out cannot fill the disk.
#
# Usage:
#   worker-build.sh <family> build <simulator-udid> [-- <xcodebuild args>]
#   worker-build.sh <family> test  <simulator-udid> [-- <xcodebuild args>]
#   worker-build.sh clean
#   worker-build.sh status

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly IOS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
readonly DERIVED_ROOT="${PHREN_IOS_DERIVED_ROOT:-/tmp/phren-ios-derived}"
readonly MIN_FREE_KB=$((8 * 1024 * 1024)) # 8 GB
readonly KEEP_ATTACHMENTS=5
readonly CLEAN_AGE_DAYS=2
# Where test .xcresult bundles and their exported attachments land: an
# overridable path, else the gitignored apps/ios/.scratch.
readonly RESULTS_DIR="${PHREN_RESULTS_DIR:-$IOS_DIR/.scratch}"

err() { printf 'worker-build: %s\n' "$*" >&2; }

usage() {
  cat >&2 <<'EOF'
usage: worker-build.sh <family> build <simulator-udid> [-- <xcodebuild args>]
       worker-build.sh <family> test  <simulator-udid> [-- <xcodebuild args>]
       worker-build.sh clean
       worker-build.sh status

  family   branch family name; shares /tmp/phren-ios-derived/<family>
  build    xcodegen + xcodebuild build-for-testing
  test     xcodebuild test-without-building, export attachments, drop bundle
  clean    remove derived-data families older than 2 days, print freed space
  status   print each family's size and free disk

  PHREN_RESULTS_DIR  where test .xcresult bundles and attachments are written
                     (default: apps/ios/.scratch, gitignored)
EOF
}

free_kb() {
  df -Pk "$1" | awk 'NR==2 {print $4}'
}

human_kb() {
  awk -v k="$1" 'BEGIN {
    if (k >= 1048576) printf "%.1f GB", k / 1048576;
    else if (k >= 1024) printf "%.1f MB", k / 1024;
    else printf "%d KB", k;
  }'
}

dir_size_kb() {
  [ -d "$1" ] || { printf '0\n'; return; }
  du -sk "$1" 2>/dev/null | awk '{print $1}'
}

require_disk() {
  local avail
  avail="$(free_kb "$DERIVED_ROOT")"
  if [ "$avail" -lt "$MIN_FREE_KB" ]; then
    err "only $(human_kb "$avail") free on the $DERIVED_ROOT volume; need at least 8 GB."
    err "run 'worker-build.sh clean' to reclaim derived data."
    exit 1
  fi
}

require_family() {
  local family="$1"
  if [ -z "$family" ]; then
    err "family is required"
    usage
    exit 2
  fi
  case "$family" in
    *[!A-Za-z0-9._-]*)
      err "invalid family '$family': use letters, digits, dot, underscore or dash"
      exit 2
      ;;
  esac
}

family_dir() { printf '%s/%s\n' "$DERIVED_ROOT" "$1"; }

prune_attachments() {
  local dir="$1" n=0
  for entry in "$dir"/*-attachments; do
    [ -d "$entry" ] || continue
    n=$((n + 1))
    if [ "$n" -gt "$KEEP_ATTACHMENTS" ]; then
      rm -rf "$entry"
    fi
  done
}

run_build() {
  local family="$1" udid="$2"
  shift 2
  local dir="$(family_dir "$family")"
  mkdir -p "$dir"
  require_disk
  (
    cd "$IOS_DIR"
    xcodegen generate -q
    xcodebuild build-for-testing \
      -skipPackagePluginValidation \
      -project Phren.xcodeproj \
      -scheme Phren \
      -destination "platform=iOS Simulator,id=$udid" \
      -derivedDataPath "$dir" \
      "$@"
  )
}

run_test() {
  local family="$1" udid="$2"
  shift 2
  local dir="$(family_dir "$family")"
  local results="$RESULTS_DIR"
  local ts bundle attachments
  mkdir -p "$dir"
  require_disk
  mkdir -p "$results"
  # Resolve before the subshell changes directory, so a relative
  # PHREN_RESULTS_DIR still points at the caller's path.
  results="$(cd "$results" && pwd)"
  ts="$(date +%Y%m%d-%H%M%S)-$$"
  bundle="$results/$ts.xcresult"
  attachments="$results/$ts-attachments"
  (
    cd "$IOS_DIR"
    xcodebuild test-without-building \
      -skipPackagePluginValidation \
      -project Phren.xcodeproj \
      -scheme Phren \
      -destination "platform=iOS Simulator,id=$udid" \
      -derivedDataPath "$dir" \
      -resultBundlePath "$bundle" \
      "$@"
  )
  if xcrun xcresulttool export attachments --path "$bundle" --output-path "$attachments"; then
    rm -rf "$bundle"
  else
    err "attachment export failed; keeping $bundle for inspection"
  fi
  prune_attachments "$results"
}

run_clean() {
  local freed_kb=0 size
  if [ ! -d "$DERIVED_ROOT" ]; then
    printf 'No derived-data families under %s.\n' "$DERIVED_ROOT"
    printf 'Free disk: %s\n' "$(human_kb "$(free_kb /tmp)")"
    return
  fi
  while IFS= read -r dir; do
    [ -n "$dir" ] || continue
    size="$(dir_size_kb "$dir")"
    rm -rf "$dir"
    freed_kb=$((freed_kb + size))
    printf 'Removed %s (%s)\n' "$dir" "$(human_kb "$size")"
  done <<EOF
$(find "$DERIVED_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +$CLEAN_AGE_DAYS)
EOF
  if [ "$freed_kb" -eq 0 ]; then
    printf 'Nothing older than %d days under %s.\n' "$CLEAN_AGE_DAYS" "$DERIVED_ROOT"
  else
    printf 'Freed %s.\n' "$(human_kb "$freed_kb")"
  fi
  printf 'Free disk: %s\n' "$(human_kb "$(free_kb /tmp)")"
}

run_status() {
  if [ -d "$DERIVED_ROOT" ]; then
    for dir in "$DERIVED_ROOT"/*; do
      [ -d "$dir" ] || continue
      printf '%s  %s\n' "$(human_kb "$(dir_size_kb "$dir")")" "$(basename "$dir")"
    done
  else
    printf 'No derived-data families under %s.\n' "$DERIVED_ROOT"
  fi
  printf 'Free disk: %s\n' "$(human_kb "$(free_kb /tmp)")"
}

# Guard the destructive paths: clean only ever removes direct children of a
# root that still looks like the shared derived-data directory.
case "$DERIVED_ROOT" in
  */phren-ios-derived) ;;
  *)
    err "refusing destructive operations: PHREN_IOS_DERIVED_ROOT must end in /phren-ios-derived"
    exit 2
    ;;
esac

cmd="${1:-}"
case "$cmd" in
  "")
    usage
    exit 2
    ;;
  clean)
    run_clean
    ;;
  status)
    run_status
    ;;
  *)
    family="$cmd"
    action="${2:-}"
    udid="${3:-}"
    if [ "$#" -gt 3 ]; then
      if [ "${4:-}" != "--" ]; then
        err "unexpected argument '${4}'; xcodebuild args must follow --"
        usage
        exit 2
      fi
      shift 4
    else
      shift "$#"
    fi
    require_family "$family"
    if [ -z "$udid" ]; then
      err "simulator-udid is required"
      usage
      exit 2
    fi
    case "$action" in
      build) run_build "$family" "$udid" "$@" ;;
      test) run_test "$family" "$udid" "$@" ;;
      *)
        err "action must be build or test"
        usage
        exit 2
        ;;
    esac
    ;;
esac