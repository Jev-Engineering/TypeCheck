#!/usr/bin/env bash
# GoDaddy Node.js Hosting release steps used by .github/workflows/deploy.yml.
# Requires: gddy, jq, git; GDDY_PAT and APP_ID in the environment.
#   ship <commit> <run>      zip the exact commit (+ release.json), upload to PREVIEW, publish to PUBLISH
#   backup <out-dir>         dump the production database through the GoDaddy tunnel, restore-drill it
#   migrate <app-dir> <port> run the app's own locked migrator against the tunnel or a drill database
#   handoff                  restart PREVIEW so a published process can take controller leadership
#   logs <out-dir>           save recent PREVIEW/PUBLISH platform logs for diagnostics
set -euo pipefail
: "${APP_ID:?}"
TUNNEL_PORT=13306
DRILL_PORT=13307

poll() { # poll <command...> -> prints final JSON; status read from .data.status
    local out status
    for _ in $(seq 1 120); do
        out="$("$@" --output json)"
        status="$(jq -r '.data.status' <<<"$out")"
        case "$status" in
            COMPLETED) echo "$out"; return 0 ;;
            FAILED|CANCELLED|ERROR) echo "$out"; echo "::error::$1 $2 $3 ended $status" >&2; return 1 ;;
        esac
        sleep 15
    done
    echo "::error::timed out waiting for $*" >&2; return 1
}

ship() {
    local commit="$1" run="$2" zip="${RUNNER_TEMP:-/tmp}/release-$1.zip"
    [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "::error::invalid commit" >&2; return 1; }
    git archive --format=zip --add-virtual-file="release.json:{\"commit\":\"$commit\",\"run\":\"$run\"}" -o "$zip" "$commit"
    echo "archive $(du -h "$zip" | cut -f1) for $commit"
    local import_id deployment_id
    import_id="$(gddy hosting source upload --app-id "$APP_ID" --file "$zip" --output json | jq -er '.data.importId')"
    echo "import_id=$import_id" | tee -a "${GITHUB_OUTPUT:-/dev/null}"
    poll gddy hosting source status --app-id "$APP_ID" --import-id "$import_id" >/dev/null
    echo "publish_started=true" >> "${GITHUB_OUTPUT:-/dev/null}"
    deployment_id="$(gddy hosting deployment publish --app-id "$APP_ID" --output json | jq -er '.data.deploymentId')"
    echo "godaddy_deployment=$deployment_id" | tee -a "${GITHUB_OUTPUT:-/dev/null}"
    poll gddy hosting deployment get --app-id "$APP_ID" --deployment-id "$deployment_id" >/dev/null
}

tunnel() { # opens the experimental GoDaddy MySQL tunnel on TUNNEL_PORT
    GDDY_MIN_STAGE=experimental gddy db tunnel --app-id "$APP_ID" --product NODEJS --port "$TUNNEL_PORT" > "${RUNNER_TEMP:-/tmp}/tunnel.log" 2>&1 &
    TUNNEL_PID=$!
    trap 'kill $TUNNEL_PID 2>/dev/null || true' EXIT
    for _ in $(seq 1 60); do (echo > /dev/tcp/127.0.0.1/$TUNNEL_PORT) 2>/dev/null && return 0; sleep 1; done
    echo "::error::database tunnel did not open" >&2; jq -c 'del(.token?)' "${RUNNER_TEMP:-/tmp}/tunnel.log" >&2 2>/dev/null || true; return 1
}

client_config() { # client_config <file> <user> <password>: credentials never appear on a command line
    umask 077; printf '[client]\nuser=%s\npassword=%s\nprotocol=TCP\nhost=127.0.0.1\n' "$2" "$3" > "$1"
}

row_counts() { # row_counts <defaults-file> <port> <database>
    local t
    for t in $(mysql --defaults-extra-file="$1" -P "$2" -N -e "SELECT table_name FROM information_schema.tables WHERE table_schema='$3' AND table_type='BASE TABLE' ORDER BY table_name"); do
        echo "$t $(mysql --defaults-extra-file="$1" -P "$2" -N -e "SELECT COUNT(*) FROM \`$3\`.\`$t\`")"
    done
}

backup() {
    local out="$1" cnf="${RUNNER_TEMP:-/tmp}/prod.cnf" drill="${RUNNER_TEMP:-/tmp}/drill.cnf" stamp version image
    : "${DB_NAME:?}" "${DB_USER:?}" "${DB_PASSWORD:?}" "${BACKUP_AGE_RECIPIENT:?}"
    mkdir -p "$out"; stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    tunnel
    client_config "$cnf" "$DB_USER" "$DB_PASSWORD"
    version="$(mysql --defaults-extra-file="$cnf" -P "$TUNNEL_PORT" -N -e 'SELECT VERSION()')"
    echo "production database server $version"
    mysqldump --defaults-extra-file="$cnf" -P "$TUNNEL_PORT" --single-transaction --skip-lock-tables --no-tablespaces \
        --set-gtid-purged=OFF --column-statistics=0 --hex-blob --default-character-set=utf8mb4 "$DB_NAME" > "$out/backup.sql"
    row_counts "$cnf" "$TUNNEL_PORT" "$DB_NAME" > "$out/source-counts.txt"
    rm -f "$cnf"; kill "$TUNNEL_PID"; trap - EXIT
    # Restore drill into a disposable server of the same family and minor version.
    if [[ "$version" == *MariaDB* ]]; then image="mariadb:$(cut -d. -f1-2 <<<"$version")"; else image="mysql:$(cut -d. -f1-2 <<<"$version")"; fi
    docker run -d --name restore-drill -e MYSQL_ROOT_PASSWORD=drill-only -e MARIADB_ROOT_PASSWORD=drill-only -p "$DRILL_PORT:3306" "$image" >/dev/null
    client_config "$drill" root drill-only
    for _ in $(seq 1 90); do mysql --defaults-extra-file="$drill" -P "$DRILL_PORT" -e 'SELECT 1' >/dev/null 2>&1 && break; sleep 2; done
    mysql --defaults-extra-file="$drill" -P "$DRILL_PORT" -e "CREATE DATABASE \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin"
    mysql --defaults-extra-file="$drill" -P "$DRILL_PORT" "$DB_NAME" < "$out/backup.sql"
    row_counts "$drill" "$DRILL_PORT" "$DB_NAME" > "$out/restored-counts.txt"
    diff -u "$out/source-counts.txt" "$out/restored-counts.txt" || { echo "::error::restore drill row counts differ" >&2; return 1; }
    echo "restore drill passed on $image: $(wc -l < "$out/source-counts.txt") tables, $(awk '{s+=$2} END {print s+0}' "$out/source-counts.txt") rows"
    age -r "$BACKUP_AGE_RECIPIENT" -o "$out/typecheck-$stamp.sql.age" "$out/backup.sql"
    shred -u "$out/backup.sql"
    sha256sum "$out/typecheck-$stamp.sql.age" | tee "$out/SHA256SUMS"
    echo "drill_port=$DRILL_PORT" >> "${GITHUB_OUTPUT:-/dev/null}"
}

migrate() { # migrate <app-dir> <tunnel|drill>
    local dir="$1" target="$2" port user password
    if [[ "$target" == tunnel ]]; then tunnel; port=$TUNNEL_PORT; user="$DB_USER"; password="$DB_PASSWORD"
    else port=$DRILL_PORT; user=root; password="drill-only"; fi
    # The candidate's migrator takes the application's named migration lock and writes the receipt last.
    (cd "$dir" && env -u GDDY_PAT DB_HOST=127.0.0.1 DB_PORT="$port" DB_USER="$user" DB_PASSWORD="$password" DB_NAME="$DB_NAME" node dist/server/migrate.js)
}

handoff() {
    gddy hosting app restart --app-id "$APP_ID" --variant PREVIEW --output json | jq -c '.data // .'
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
