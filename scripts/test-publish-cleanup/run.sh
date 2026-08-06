#!/usr/bin/env bash
#
# Exercises the two Hub-cleanup steps of .github/workflows/docker-publish.yml
# against a stubbed Docker Hub API.
#
#   npm run test:publish-cleanup
#
# Why this exists: that shell deletes manifests from a public registry, and it
# only ever runs during a real publish. Three consecutive attempts at it shipped
# broken — the last one 404ed on its first API call and reported success anyway,
# because the step is continue-on-error. Nothing in the repository could have
# caught that. These scenarios cover the cases that were wrong (a status other
# than 2xx counted as a deletion, a keep-set truncated at one page, a 200 login
# carrying no token) plus the ones that must never regress (a shared
# sub-manifest surviving, an empty keep-set aborting, a failed login, a failed
# listing and an exhausted page cap all leaving the publish alone).
#
# The step scripts are re-extracted from the workflow on every run, so there is
# no checked-in copy to drift out of date.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# Git Bash launched from a native Windows shell (`npm run`) reports pwd as
# C:/... — prepending that to PATH would split on the drive letter's colon and
# the stubs below would never be found. cygpath exists only there.
if command -v cygpath >/dev/null 2>&1; then
  HERE="$(cygpath -u "${HERE}")"
fi

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

STEPS="${WORK}/steps"
FIXTURES="${WORK}/fixtures"

node "${HERE}/extract-steps.mjs" "${STEPS}" || exit 1
node "${HERE}/make-fixtures.mjs" "${FIXTURES}" || exit 1

# The stubs shadow the real curl and jq, which CI runners do have installed.
export PATH="${HERE}/stubs:${PATH}"

# Nothing here may reach the network. If PATH resolution ever misses the stubs,
# the steps would talk to the real Docker Hub with whatever credentials are in
# the environment — and delete manifests for real. Fail loudly instead.
for tool in curl jq; do
  resolved="$(command -v "${tool}" || true)"
  if [ "${resolved}" != "${HERE}/stubs/${tool}" ]; then
    echo "error: ${tool} resolves to '${resolved:-nothing}', not ${HERE}/stubs/${tool}" >&2
    echo "       Refusing to run — these tests must never reach the real Docker Hub." >&2
    exit 1
  fi
done

# Mirrors the workflow-level env the steps read.
DEFAULT_MAX_TAG_PAGES=20
# Lowered for the pagination-exhaustion scenario so it needs three page fixtures
# rather than twenty-one.
EXHAUSTED_MAX_TAG_PAGES=2

export IMAGE_NAME=i7gamer/tutto
export HUB_API=https://hub.docker.com/v2
export HUB_API_PAGE_SIZE=100
export MAX_TAG_PAGES="${DEFAULT_MAX_TAG_PAGES}"
export SUPERSEDED_DIGESTS_FILE="${WORK}/superseded-digests.txt"
export DOCKERHUB_USERNAME=test-user
export DOCKERHUB_TOKEN=test-token

passed=0
failed=0

pass() { passed=$((passed + 1)); }
fail() { echo "  FAIL: $1"; failed=$((failed + 1)); }

assert_contains() {
  case "$2" in
    *"$1"*) pass ;;
    *) fail "expected output to contain '$1'" ;;
  esac
}

assert_not_contains() {
  case "$2" in
    *"$1"*) fail "expected output not to contain '$1'" ;;
    *) pass ;;
  esac
}

assert_exit_zero() {
  # Cleanup runs continue-on-error, so a non-zero exit is a red annotation on
  # an otherwise green publish — exactly how the last breakage stayed hidden.
  [ "$1" -eq 0 ] && pass || fail "expected exit 0, got $1"
}

assert_recorded_digests() {
  local actual
  actual="$(wc -l < "${SUPERSEDED_DIGESTS_FILE}" | tr -d ' ')"
  [ "${actual}" = "$1" ] && pass || fail "expected $1 recorded digests, got ${actual}"
}

scenario() {
  echo "== $1 =="
  export FIXTURE_DIR="${FIXTURES}/$2"
  rm -f "${SUPERSEDED_DIGESTS_FILE}"
}

run_step() { bash "${STEPS}/$1.sh" 2>&1; }

scenario 'first publish under this tag' first-publish
export REQUESTED_TAGS=nightly
out="$(run_step record)"; status=$?
assert_exit_zero "${status}"
assert_contains 'nothing to supersede (HTTP 404)' "${out}"
out="$(run_step delete)"; status=$?
assert_exit_zero "${status}"
assert_contains 'superseded nothing' "${out}"

scenario 'republish keeps a sub-manifest the new index still shares' shared-submanifest
export REQUESTED_TAGS='latest, 1.1.3'
out="$(run_step record)"; status=$?
assert_exit_zero "${status}"
assert_contains 'latest: recorded' "${out}"
assert_contains '1.1.3: nothing to supersede' "${out}"
assert_recorded_digests 3
out="$(run_step delete)"; status=$?
assert_exit_zero "${status}"
assert_contains 'keeping sha256:aaa' "${out}"
assert_contains 'deleted sha256:old0' "${out}"
assert_contains 'deleted sha256:old1' "${out}"
assert_contains 'Deleted 2 superseded manifest(s), 0 failure(s)' "${out}"

scenario 'a rejected delete is reported, not counted as done' delete-refused
export REQUESTED_TAGS=latest
run_step record >/dev/null
out="$(run_step delete)"; status=$?
assert_exit_zero "${status}"
assert_contains '::warning::could not delete sha256:old0 — HTTP 405' "${out}"
assert_contains 'Deleted 0 superseded manifest(s), 1 failure(s)' "${out}"

scenario 'the keep-set spans more than one page' paginated
export REQUESTED_TAGS=latest
run_step record >/dev/null
out="$(run_step delete)"; status=$?
assert_exit_zero "${status}"
assert_contains 'keeping sha256:page2' "${out}"
assert_contains 'deleted sha256:old1' "${out}"

scenario 'an empty tag listing aborts instead of deleting' empty-keepset
export REQUESTED_TAGS=latest
run_step record >/dev/null
out="$(run_step delete)"; status=$?
assert_exit_zero "${status}"
assert_contains '::warning::no referenced digests read back' "${out}"
assert_not_contains 'deleted sha256:' "${out}"

scenario 'a failed login warns and leaves the publish alone' login-fails
export REQUESTED_TAGS=latest
out="$(run_step record)"; status=$?
assert_exit_zero "${status}"
assert_contains '::warning::could not authenticate' "${out}"
out="$(run_step delete)"; status=$?
assert_exit_zero "${status}"
assert_contains 'superseded nothing' "${out}"

# Hub answers a 2FA-enabled account with HTTP 200 and no `token` field, so curl
# succeeds and jq prints the string "null". Checking only curl's exit status
# lets that through as a four-character JWT, and every later call 401s while the
# steps report "nothing to supersede" — silently, forever.
scenario 'a login that returns no token warns instead of sending "JWT null"' login-no-token
export REQUESTED_TAGS=latest
out="$(run_step record)"; status=$?
assert_exit_zero "${status}"
assert_contains '::warning::the Docker Hub API returned no token' "${out}"
assert_not_contains 'latest: recorded' "${out}"
assert_recorded_digests 0
# The delete step logs in again on its own, and its "superseded nothing" early
# exit would hide the second guard. Seed the file a successful record would have
# written so the step gets past that and reaches the login.
printf 'sha256:old0\n' > "${SUPERSEDED_DIGESTS_FILE}"
out="$(run_step delete)"; status=$?
assert_exit_zero "${status}"
assert_contains '::warning::the Docker Hub API returned no token' "${out}"
assert_not_contains 'deleted sha256:' "${out}"

scenario 'a failed tag listing aborts rather than delete against a partial keep-set' tag-list-fails
export REQUESTED_TAGS=latest
run_step record >/dev/null
out="$(run_step delete)"; status=$?
assert_exit_zero "${status}"
assert_contains '::warning::could not list tags' "${out}"
assert_not_contains 'deleted sha256:' "${out}"

scenario 'a listing that never stops paginating aborts at the page cap' too-many-pages
export REQUESTED_TAGS=latest
export MAX_TAG_PAGES="${EXHAUSTED_MAX_TAG_PAGES}"
run_step record >/dev/null
out="$(run_step delete)"; status=$?
assert_exit_zero "${status}"
assert_contains "::warning::more than ${EXHAUSTED_MAX_TAG_PAGES} pages of tags" "${out}"
assert_not_contains 'deleted sha256:' "${out}"
export MAX_TAG_PAGES="${DEFAULT_MAX_TAG_PAGES}"

echo
echo "passed: ${passed}  failed: ${failed}"
[ "${failed}" -eq 0 ]
