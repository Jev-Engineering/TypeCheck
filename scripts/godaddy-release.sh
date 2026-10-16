#!/usr/bin/env bash
# GoDaddy Node.js Hosting release steps used by .github/workflows/deploy.yml.
# Requires: gddy, jq, git; GDDY_PAT and APP_ID in the environment.
#   ship <commit> <run>        zip the exact commit (+ release.json), upload to PREVIEW, publish to PUBLISH
#   backup <out-dir>           dump the production database through the GoDaddy tunnel, restore-drill it
#   build_migrator <commit>    build the candidate as the unprivileged `candidate` user
#   migrate <drill|tunnel>     run the candidate's locked migrator as that user
#   verify                     verify-production.mjs, handing controller ownership to PUBLISH if needed
#   logs <out-dir>             save recent PREVIEW/PUBLISH platform logs for diagnostics
set -euo pipefail
: "${APP_ID:?}"
TUNNEL_PORT=13306
DRILL_PORT=13307
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
    local commit="$1" run="$2" zip="$RUNNER_TEMP/release-$1.zip" import_id deployment_id
    [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "::error::invalid commit" >&2; return 1; }
    git archive --format=zip --add-virtual-file="release.json:{\"commit\":\"$commit\",\"run\":\"$run\"}" -o "$zip" "$commit"
    echo "archive $(du -h "$zip" | cut -f1) for $commit"
    import_id="$(gddy hosting source upload --app-id "$APP_ID" --file "$zip" --output json | jq -er '.data.importId')"
    echo "import_id=$import_id" | tee -a "${GITHUB_OUTPUT:-/dev/null}"
    poll gddy hosting source status --app-id "$APP_ID" --import-id "$import_id"
    echo "publish_started=true" >> "${GITHUB_OUTPUT:-/dev/null}"
    deployment_id="$(gddy hosting deployment publish --app-id "$APP_ID" --output json | jq -er '.data.deploymentId')"
    echo "godaddy_deployment=$deployment_id" | tee -a "${GITHUB_OUTPUT:-/dev/null}"
    poll gddy hosting deployment get --app-id "$APP_ID" --deployment-id "$deployment_id"
}

tunnel() { # opens the experimental GoDaddy MySQL tunnel on TUNNEL_PORT
    GDDY_MIN_STAGE=experimental gddy db tunnel --app-id "$APP_ID" --product NODEJS --port "$TUNNEL_PORT" > "$RUNNER_TEMP/tunnel.log" 2>&1 &
    TUNNEL_PID=$!
    trap 'kill $TUNNEL_PID 2>/dev/null || true' EXIT
    for _ in $(seq 1 60); do (echo > /dev/tcp/127.0.0.1/$TUNNEL_PORT) 2>/dev/null && return 0; sleep 1; done
    echo "::error::database tunnel did not open" >&2; jq -rc '.error? // empty' "$RUNNER_TEMP/tunnel.log" >&2 2>/dev/null || true; return 1
}

client_config() { # client_config <file> <user> <password>: credentials never appear on a command line
    (umask 077; printf '[client]\nuser=%s\npassword=%s\nprotocol=TCP\nhost=127.0.0.1\n' "$2" "$3" > "$1")
}

dump_counts() { # rows per table counted in the dump itself (one INSERT per row), so live writes cannot race it
    awk 'match($0, /^CREATE TABLE `[^`]+`/) { t = substr($0, 15, RLENGTH - 15); n[t] += 0 }
         match($0, /^INSERT INTO `[^`]+` VALUES/) { t = substr($0, 14, index(substr($0, 14), "`") - 1); n[t]++ }
         END { for (t in n) print t, n[t] }' "$1" | sort
}

db_counts() { # db_counts <defaults-file> <port> <database>
    local t
    for t in $(mysql --defaults-extra-file="$1" -P "$2" -N -e "SELECT table_name FROM information_schema.tables WHERE table_schema='$3' AND table_type='BASE TABLE' ORDER BY table_name"); do
        echo "$t $(mysql --defaults-extra-file="$1" -P "$2" -N -e "SELECT COUNT(*) FROM \`$3\`.\`$t\`")"
    done | sort
}

backup() {
    local out="$1" cnf="$RUNNER_TEMP/prod.cnf" drill="$RUNNER_TEMP/drill.cnf" stamp version image
    : "${DB_NAME:?}" "${DB_USER:?}" "${DB_PASSWORD:?}" "${BACKUP_AGE_RECIPIENT:?}"
    mkdir -p "$out"; stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    tunnel
    client_config "$cnf" "$DB_USER" "$DB_PASSWORD"
    version="$(mysql --defaults-extra-file="$cnf" -P "$TUNNEL_PORT" -N -e 'SELECT VERSION()')"
    echo "production database server $version"
    mysqldump --defaults-extra-file="$cnf" -P "$TUNNEL_PORT" --single-transaction --skip-lock-tables --no-tablespaces \
        --skip-extended-insert --set-gtid-purged=OFF --column-statistics=0 --hex-blob --default-character-set=utf8mb4 "$DB_NAME" > "$out/backup.sql"
    rm -f "$cnf"; kill "$TUNNEL_PID" 2>/dev/null || true; trap - EXIT
    dump_counts "$out/backup.sql" > "$out/source-counts.txt"
    # Restore drill into a disposable server of the same family and major.minor version.
    if [[ "$version" == *MariaDB* ]]; then image="mariadb:$(cut -d. -f1-2 <<<"$version")"; else image="mysql:$(cut -d. -f1-2 <<<"${version%%-*}")"; fi
    docker rm -f restore-drill >/dev/null 2>&1 || true
    docker run -d --name restore-drill -e MYSQL_ROOT_PASSWORD=drill-only -e MARIADB_ROOT_PASSWORD=drill-only -p "127.0.0.1:$DRILL_PORT:3306" "$image" >/dev/null
    client_config "$drill" root drill-only
    for _ in $(seq 1 90); do mysql --defaults-extra-file="$drill" -P "$DRILL_PORT" -e 'SELECT 1' >/dev/null 2>&1 && break; sleep 2; done
    mysql --defaults-extra-file="$drill" -P "$DRILL_PORT" -e "CREATE DATABASE \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin"
    mysql --defaults-extra-file="$drill" -P "$DRILL_PORT" "$DB_NAME" < "$out/backup.sql"
    db_counts "$drill" "$DRILL_PORT" "$DB_NAME" > "$out/restored-counts.txt"
    diff -u "$out/source-counts.txt" "$out/restored-counts.txt" || { echo "::error::restore drill row counts differ" >&2; return 1; }
    echo "restore drill passed on $image: $(wc -l < "$out/source-counts.txt") tables, $(awk '{s+=$2} END {print s+0}' "$out/source-counts.txt") rows"
    age -r "$BACKUP_AGE_RECIPIENT" -o "$out/typecheck-$stamp.sql.age" "$out/backup.sql"
    shred -u "$out/backup.sql"
    (cd "$out" && sha256sum "typecheck-$stamp.sql.age" | tee SHA256SUMS)
}

as_candidate() { # runs a command as the unprivileged candidate user; extra env arrives on stdin, not argv
    sudo -u candidate -H env -i PATH="$PATH" HOME=/home/candidate bash -c "set -a; source /dev/stdin; set +a; cd ~/app && $1"
}

build_migrator() {
    local commit="$1"
    id candidate >/dev/null 2>&1 || sudo useradd --create-home --shell /usr/sbin/nologin candidate
    sudo -u candidate mkdir -p /home/candidate/app
    git archive "$commit" | sudo -u candidate tar -x -C /home/candidate/app
    : | as_candidate 'npm ci --omit=dev --ignore-scripts --no-audit --no-fund && node node_modules/typescript/bin/tsc'
}

migrate() { # migrate <drill|tunnel>
    local port user password
    : "${DB_NAME:?}"
    if [[ "$1" == tunnel ]]; then tunnel; port=$TUNNEL_PORT; user="$DB_USER"; password="$DB_PASSWORD"
    else port=$DRILL_PORT; user=root; password="drill-only"; fi
    # The candidate's migrator takes the application's named migration lock and writes the receipt last.
    printf 'DB_HOST=127.0.0.1\nDB_PORT=%s\nDB_USER=%q\nDB_PASSWORD=%q\nDB_NAME=%q\n' "$port" "$user" "$password" "$DB_NAME" \
        | as_candidate 'node dist/server/migrate.js'
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
