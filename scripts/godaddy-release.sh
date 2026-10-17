#!/usr/bin/env bash
# GoDaddy Node.js Hosting release steps used by .github/workflows/deploy.yml.
# Requires: gddy, jq, git; GDDY_PAT and APP_ID in the environment.
#   ship <commit> <run> [migrate]  zip the exact commit (+ release.json), upload to PREVIEW, publish to PUBLISH;
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
                COMPLETED) return 0 ;;
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
    local commit="$1" run="$2" migrate=false zip="$RUNNER_TEMP/release-$1.zip" import_id deployment_id
    [[ "$commit" =~ ^[0-9a-f]{40}$ && "$run" =~ ^[0-9]+-[0-9]+$ ]] || { echo "::error::invalid commit or run" >&2; return 1; }
    [[ "${3:-}" == migrate ]] && migrate=true
    echo "started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "${GITHUB_OUTPUT:-/dev/null}"
    git archive --format=zip --add-virtual-file="release.json:{\"commit\":\"$commit\",\"run\":\"$run\",\"migrate\":$migrate}" -o "$zip" "$commit"
    echo "archive $(du -h "$zip" | cut -f1) for $commit (migrate=$migrate)"
    import_id="$(gddy hosting source upload --app-id "$APP_ID" --file "$zip" --output json | jq -er '.data.importId')"
    echo "import_id=$import_id" | tee -a "${GITHUB_OUTPUT:-/dev/null}"
    poll gddy hosting source status --app-id "$APP_ID" --import-id "$import_id"
    echo "publish_started=true" >> "${GITHUB_OUTPUT:-/dev/null}"
    deployment_id="$(gddy hosting deployment publish --app-id "$APP_ID" --output json | jq -er '.data.deploymentId')"
    echo "godaddy_deployment=$deployment_id" | tee -a "${GITHUB_OUTPUT:-/dev/null}"
    poll gddy hosting deployment get --app-id "$APP_ID" --deployment-id "$deployment_id"
}

verify() {
    local code=0 attempt
    node scripts/verify-production.mjs || code=$?
    for attempt in 1 2; do
        [[ $code -eq 3 ]] || break
        # PREVIEW (same code, same database) won the controller lock. Restarting it releases the
        # lock; PUBLISH retries every five seconds and normally takes over.
        echo "::notice::PUBLISH is standby; restarting PREVIEW (attempt $attempt)"
        gddy hosting app restart --app-id "$APP_ID" --variant PREVIEW --output json >/dev/null
        code=0; TIMEOUT_SECONDS=180 node scripts/verify-production.mjs || code=$?
    done
    if [[ $code -eq 3 ]]; then
        echo "::warning::Release verified, but PUBLISH is still standby: PREVIEW holds controller leadership. Check docs/DEPLOYMENT.md#controller-ownership."
        return 0
    fi
    return "$code"
}

receipt() { # receipt <since>: the release logs one database_migration line per migrating process
    local since="$1" v found="" summary
    : "${CANDIDATE:?}"
    for _ in $(seq 1 12); do # platform logs can lag a few minutes
        for v in PREVIEW PUBLISH; do
            found+="$(gddy hosting log list --app-id "$APP_ID" --variant "$v" --since "$since" --source STDOUT --output json 2>/dev/null \
                | jq -c --arg c "$CANDIDATE" --arg v "$v" '.data[]?.message | fromjson? | select(type == "object" and .event == "database_migration" and .release == $c) | . + {variant: $v}' 2>/dev/null || true)"
            found+=$'\n'
        done
        [[ -n "${found//$'\n'/}" ]] && break
        found=""
        sleep 15
    done
    [[ -n "$found" ]] || { echo "::warning::no database_migration log line found for $CANDIDATE"; return 1; }
    echo "$found"
    summary="$(jq -rs '[.[] | select(.backup != null)][0] // empty | "\(.backup.file) (sha256 \(.backup.sha256[0:16])…, \(.backup.tables) tables, \(.backup.rows) rows, \(.variant))"' <<<"$found")"
    if [[ -n "$summary" ]]; then
        echo "backup=$summary" >> "${GITHUB_OUTPUT:-/dev/null}"
    elif jq -es 'all(.applied == [])' <<<"$found" >/dev/null; then
        echo "backup=not needed: schema was already current" >> "${GITHUB_OUTPUT:-/dev/null}"
    else
        echo "::warning::migration applied without a backup receipt"; return 1
    fi
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
