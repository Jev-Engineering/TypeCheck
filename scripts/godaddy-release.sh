#!/usr/bin/env bash
# GoDaddy Node.js Hosting release steps used by .github/workflows/deploy.yml.
# Requires: gddy, jq, git; GDDY_PAT and APP_ID in the environment.
#   ship <commit> <run> [migrate]  import a verified release branch (+ release.json) into PREVIEW, publish to PUBLISH;
#                                  `migrate` lets the release apply its admitted migrations at startup
#   verify                         verify-production.mjs, handing controller ownership to PUBLISH if needed
#   receipt <since>                find the release's database_migration log line and its backup receipt
#   logs <out-dir>                 save recent PREVIEW/PUBLISH platform logs for diagnostics
set -euo pipefail
: "${APP_ID:?}"
RUNNER_TEMP="${RUNNER_TEMP:-/tmp}"

poll() { # poll <command...>: up to 10 minutes; tolerates a few transient CLI/API errors
    local out status errors=0
    for _ in $(seq 1 40); do
        if out="$("$@" --output json 2>/dev/null)" && status="$(jq -er '.data.status' <<<"$out" 2>/dev/null)"; then
            case "$status" in
                COMPLETED) printf '%s\n' "$out"; return 0 ;;
                FAILED|CANCELLED|ERROR) echo "::error::$2 $3 ended $status" >&2; return 1 ;;
            esac
        elif (( ++errors > 5 )); then
            echo "::error::$2 $3 status unavailable after repeated errors" >&2; return 1
        fi
        sleep 15
    done
    echo "::error::timed out waiting for $2 $3" >&2; return 1
}

ship() {
    local commit="$1" run="$2" migration="${3:-no-migrate}" source branch oid imported published import_id deployment_id app head receipt receipt_hash
    [[ "$commit" =~ ^[0-9a-f]{40}$ && "$run" =~ ^[0-9]+-[0-9]+$ ]] || { echo "::error::invalid commit or run" >&2; return 1; }
    echo "started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "${GITHUB_OUTPUT:-/dev/null}"
    source="$(node scripts/release-source.mjs "$commit" "$run" "$migration")"
    branch="$(jq -er .branch <<<"$source")"; oid="$(jq -er .oid <<<"$source")"
    echo "release_branch=$branch" | tee -a "${GITHUB_OUTPUT:-/dev/null}"
    echo "release_source=$oid" | tee -a "${GITHUB_OUTPUT:-/dev/null}"
    import_id="$(gddy hosting source github --app-id "$APP_ID" --repo "$GITHUB_REPOSITORY" --branch "$branch" --output json | jq -er '.data.importId')"
    echo "import_id=$import_id" | tee -a "${GITHUB_OUTPUT:-/dev/null}"
    imported="$(poll gddy hosting source status --app-id "$APP_ID" --import-id "$import_id")"
    jq -c '.data | {importId,importType,status,gitHash,fields:keys}' <<<"$imported"
    app="$(gddy hosting app get --app-id "$APP_ID" --output json)"
    head="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/$branch" --jq '.object.sha')"
    jq -s '.' <(printf '%s' "$imported") <(printf '%s' "$app") | node scripts/verify-provider-source.mjs import "$import_id" "$GITHUB_REPOSITORY" "$branch" "$oid" "$head"
    echo "publish_started=true" >> "${GITHUB_OUTPUT:-/dev/null}"
    receipt="$(gddy hosting deployment publish --app-id "$APP_ID" --output json)"
    deployment_id="$(jq -er '.data.deploymentId' <<<"$receipt")"
    receipt_hash="$(jq -r '.data.gitHash // empty' <<<"$receipt")"
    echo "godaddy_deployment=$deployment_id" | tee -a "${GITHUB_OUTPUT:-/dev/null}"
    published="$(poll gddy hosting deployment get --app-id "$APP_ID" --deployment-id "$deployment_id")"
    app="$(gddy hosting app get --app-id "$APP_ID" --output json)"
    head="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/heads/$branch" --jq '.object.sha')"
    jq -s '.' <(printf '%s' "$published") <(printf '%s' "$app") | node scripts/verify-provider-source.mjs deployment "$deployment_id" "$GITHUB_REPOSITORY" "$branch" "$oid" "$head" "$receipt_hash"
}

restart_preview() { # GoDaddy rejects restarts (404 "failed to restart") while PREVIEW is still settling after publish
    local try out
    for try in 1 2 3 4; do
        if out="$(gddy hosting app restart --app-id "$APP_ID" --variant PREVIEW --output json 2>&1)"; then
            return 0
        fi
        echo "::warning::PREVIEW restart attempt $try failed: $(jq -c '.error // .' <<<"$out" 2>/dev/null || printf '%s' "$out" | head -c 300)"
        (( try < 4 )) && sleep $(( try * 15 ))
    done
    return 1
}

verify() {
    local code=0 attempt
    node scripts/verify-production.mjs || code=$?
    for attempt in 1 2; do
        [[ $code -eq 3 ]] || break
        # PUBLISH has finished its startup delay. Restarting PREVIEW drains its controllers,
        # then its 30s election delay gives the running PUBLISH's 5s retries time to acquire.
        echo "::notice::PUBLISH is standby; restarting PREVIEW (attempt $attempt)"
        # A failed restart is not fatal by itself: re-verify so a handoff that still happened is recognized.
        restart_preview || echo "::warning::PREVIEW restart unavailable after retries; re-verifying controller ownership"
        code=0; TIMEOUT_SECONDS=180 node scripts/verify-production.mjs || code=$?
    done
    if [[ $code -eq 3 ]]; then
        echo "::error::PUBLISH is still standby after bounded handoff attempts; controller ownership is unconfirmed."
        return 1
    fi
    return "$code"
}

receipt() { # bounded retrieval; metadata only, never database contents
    local since="$1" v found summary records
    : "${CANDIDATE:?}"
    for _ in $(seq 1 12); do
        found=""
        for v in PREVIEW PUBLISH; do
            if ! records="$(timeout 30s gddy hosting log list --app-id "$APP_ID" --variant "$v" --since "$since" --source STDOUT --limit 500 --output json 2>/dev/null | node scripts/migration-receipt.mjs extract "$CANDIDATE" "$v")"; then
                echo "::warning::migration log retrieval or validation failed for $v; backup status unknown"
                return 1
            fi
            found+="$records"$'\n'
        done
        if summary="$(node scripts/migration-receipt.mjs summary "$CANDIDATE" <<<"$found")"; then
            printf '%s\n' "$summary"
            return 0
        fi
        sleep 15
    done
    echo "::warning::complete migration receipt unavailable for $CANDIDATE; backup status unknown"
    return 1
}

logs() {
    local out="$1" v
    mkdir -p "$out"
    for v in PUBLISH PREVIEW; do
        gddy hosting log list --app-id "$APP_ID" --variant "$v" --limit 300 --output json \
            | jq -r '.data[]? | "\(.timestamp) \(.level) \(.message)"' \
            | sed -E 's/((token|secret|password|authorization|key)[^ =:]*[=:] *)[^ ,"]+/\1<redacted>/Ig' > "$out/$v.log" || true
    done
}

"$@"
