// Decides whether a production release may proceed automatically.
// Usage: node scripts/release-guard.mjs <live-commit> <candidate-commit> [--rollback]
// Prints one JSON object; exits 1 when the release must not proceed automatically.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const isAncestor = (a, b) => { try { execFileSync('git', ['merge-base', '--is-ancestor', a, b], { stdio: 'ignore' }); return true; } catch { return false; } };

// An expand-only migration creates tables, and writes rows only into tables it created
// or into the version receipt. Old and new application versions can both run against
// the result, so neither a drain nor a schema rollback is needed.
export function sqlStatements(sql) {
    return sql.replace(/--[^\n]*/g, '').split(';').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
export function classifyMigration(sql) {
    const created = new Set(['schema_migrations']), blocked = [];
    for (const s of sqlStatements(sql)) {
        const table = /^CREATE TABLE IF NOT EXISTS (\w+)/i.exec(s);
        if (table) { created.add(table[1].toLowerCase()); continue; }
        const index = /^CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?\w+ ON (\w+)/i.exec(s);
        const insert = /^INSERT INTO (\w+)/i.exec(s);
        if (!(index ?? insert) || !created.has((index ?? insert)[1].toLowerCase())) blocked.push(s.slice(0, 80));
    }
    return blocked.length ? { kind: 'incompatible', blocked } : { kind: 'expand' };
}
// changes: [{ status: 'A'|'M'|'D'|..., path, sql? }]
export function classifyChanges(changes) {
    const files = changes.filter(c => c.path.startsWith('db/'));
    if (!files.length) return { migrations: 'none', files: [] };
    const reasons = [];
    for (const f of files) {
        if (f.status !== 'A') reasons.push(`${f.path}: existing migration ${f.status === 'D' ? 'deleted' : 'modified'}`);
        else if (f.path.endsWith('.sql')) {
            const c = classifyMigration(f.sql ?? '');
            if (c.kind !== 'expand') reasons.push(`${f.path}: ${c.blocked.join(' | ')}`);
        }
    }
    return { migrations: reasons.length ? 'incompatible' : 'expand', files: files.map(f => f.path), reasons };
}
export function decide({ relation, rollback, changes }) {
    if (relation === 'same') return { proceed: true, action: 'redeploy', ...changes };
    if (relation === 'forward') {
        if (changes.migrations === 'incompatible') return { proceed: false, action: 'blocked', reason: 'migration_requires_maintenance_window', ...changes };
        return { proceed: true, action: 'deploy', ...changes };
    }
    if (relation === 'older') {
        if (!rollback) return { proceed: false, action: 'blocked', reason: 'candidate_older_than_live_release', ...changes };
        // Reverting code never reverts schema: the older code must tolerate the newer schema.
        if (changes.migrations === 'incompatible') return { proceed: false, action: 'blocked', reason: 'rollback_target_incompatible_with_live_schema', ...changes };
        return { proceed: true, action: 'rollback', ...changes };
    }
    return { proceed: false, action: 'blocked', reason: 'live_and_candidate_diverged', ...changes };
}
function changesBetween(from, to) {
    const out = git('diff', '--name-status', '--no-renames', from, to, '--', 'db/');
    return out ? out.split('\n').map(line => {
        const [status, path] = line.split('\t');
        return { status, path, sql: status === 'A' ? git('show', `${to}:${path}`) : undefined };
    }) : [];
}
function main() {
    const [live, candidate] = process.argv.slice(2).filter(a => !a.startsWith('--')).map(r => git('rev-parse', '--verify', `${r}^{commit}`));
    const rollback = process.argv.includes('--rollback');
    const relation = live === candidate ? 'same' : isAncestor(live, candidate) ? 'forward' : isAncestor(candidate, live) ? 'older' : 'diverged';
    // For a rollback the schema delta is the one the older code must tolerate.
    const changes = classifyChanges(relation === 'older' ? changesBetween(candidate, live) : changesBetween(live, candidate));
    const result = { live, candidate, relation, ...decide({ relation, rollback, changes }) };
    console.log(JSON.stringify(result));
    process.exit(result.proceed ? 0 : 1);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
