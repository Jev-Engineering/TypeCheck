import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { releaseSpec, verifyArtifact, createReleaseSource, verifyProviderSource } from './release-source.mjs';

const commit = 'a'.repeat(40), oid = 'b'.repeat(40);
const spec = releaseSpec('Jev-Engineering/TypeCheck', commit, '123-1', true);
const original = { truncated: false, tree: [{ path: 'server', mode: '040000', type: 'tree', sha: 'c'.repeat(40) }] };
const metadata = { path: 'release.json', mode: '100644', type: 'blob', sha: createHash('sha1').update(`blob ${Buffer.byteLength(spec.content)}\0`).update(spec.content).digest('hex') };
const artifact = { sha: oid, parents: [{ sha: commit }], commit: { verification: { verified: true } } };
const tree = { truncated: false, tree: [...original.tree, metadata] };

test('release names isolate attempts, candidates and migration vs rollback metadata', () => {
    assert.deepEqual(JSON.parse(spec.content), { commit, run: '123-1', migrate: true });
    assert.notEqual(spec.branch, releaseSpec(spec.repository, commit, '123-2', true).branch);
    assert.notEqual(spec.branch, releaseSpec(spec.repository, commit, '123-1', false).branch);
    for (const args of [['bad', commit, '123-1', true], [spec.repository, 'main', '123-1', true], [spec.repository, commit, '123;command', true], [spec.repository, commit, '123-1', 'true']])
        assert.throws(() => releaseSpec(...args));
});

test('signed release artifact contains exactly the approved source and bound metadata', () => {
    verifyArtifact(spec, artifact, original, tree);
    for (const change of [a => { a.parents = [{ sha: oid }]; }, a => { a.parents.push({ sha: oid }); }, a => { a.commit.verification.verified = false; }]) {
        const a = structuredClone(artifact); change(a); assert.throws(() => verifyArtifact(spec, a, original, tree));
    }
    for (const change of [t => { t.truncated = true; }, t => { t.tree[0].sha = oid; }, t => { t.tree[1].sha = oid; }, t => { t.tree[1].mode = '120000'; }, t => { t.tree.pop(); }, t => { t.tree.push({ path: 'extra', mode: '100644', type: 'blob', sha: oid }); }]) {
        const t = structuredClone(tree); change(t); assert.throws(() => verifyArtifact(spec, artifact, original, t));
    }
    assert.throws(() => verifyArtifact(spec, artifact, tree, tree));
});

function fakeApi({ collision = false, moved = false, failed = false } = {}) {
    const calls = [];
    return { calls, api(endpoint, body) {
        calls.push({ endpoint, body });
        if (endpoint.endsWith(`/git/trees/${commit}`)) return original;
        if (endpoint.endsWith('/git/refs')) { if (collision) throw new Error('existing branch'); return {}; }
        if (endpoint === 'graphql') return failed ? { errors: ['conflict'] } : { data: { createCommitOnBranch: { commit: { oid } } } };
        if (endpoint.endsWith(`/commits/${oid}`)) return artifact;
        if (endpoint.endsWith(`/git/trees/${oid}`)) return tree;
        if (endpoint.includes('/git/ref/heads/')) return { object: { sha: moved ? commit : oid } };
        throw new Error('unexpected request');
    } };
}
test('fresh ref and atomic expected-head mutation precede source verification', () => {
    const f = fakeApi();
    assert.deepEqual(createReleaseSource(spec, f.api), { branch: spec.branch, oid });
    assert.deepEqual(f.calls[1].body, { ref: `refs/heads/${spec.branch}`, sha: commit });
    const input = f.calls[2].body.variables.input;
    assert.equal(input.expectedHeadOid, commit);
    assert.deepEqual(input.fileChanges, { additions: [{ path: 'release.json', contents: Buffer.from(spec.content).toString('base64') }] });
});
test('collisions, concurrent branch changes and failed commit creation abort without overwriting refs', () => {
    for (const options of [{ collision: true }, { moved: true }, { failed: true }]) {
        const f = fakeApi(options); assert.throws(() => createReleaseSource(spec, f.api));
        assert.ok(!f.calls.some(c => c.body?.force));
    }
});

test('null provider hashes require exact operation, repository, branch and verified head binding', () => {
    const result = { importId: 'i', importType: 'GITHUB', status: 'COMPLETED', gitHash: null };
    const app = { source: 'GITHUB', sourceDetails: { repositoryFullName: spec.repository, branch: spec.branch } };
    const expected = { kind: 'import', id: 'i', repository: spec.repository, branch: spec.branch, oid, head: oid };
    assert.equal(verifyProviderSource(result, app, expected).providerHash, null);
    assert.equal(verifyProviderSource({ ...result, gitHash: oid }, app, expected).providerHash, oid);
    for (const change of [{ status: 'PENDING' }, { importId: 'other' }, { importType: 'ZIP' }, { gitHash: commit }, { gitHash: '' }])
        assert.throws(() => verifyProviderSource({ ...result, ...change }, app, expected));
    for (const change of [{ source: 'ZIP' }, { sourceDetails: { repositoryFullName: 'other/repo', branch: spec.branch } }, { sourceDetails: { repositoryFullName: spec.repository, branch: 'main' } }])
        assert.throws(() => verifyProviderSource(result, { ...app, ...change }, expected));
    assert.throws(() => verifyProviderSource(result, app, { ...expected, head: commit }));
    assert.throws(() => verifyProviderSource(result, app, { ...expected, kind: 'deployment' }));
});

test('ship uses GitHub imports and prevents publication on failed or mismatched source', { skip: process.platform === 'win32' }, t => {
    const dir = mkdtempSync(join(tmpdir(), 'release-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
    for (const name of ['gddy', 'gh', 'node']) {
        const contents = name === 'node' ? `if [[ "$1" == scripts/release-source.mjs ]]; then echo '{"branch":"releases/test","oid":"${oid}"}'; else exec '${process.execPath}' "$@"; fi` : name === 'gh' ? `echo "\${REF_HASH:-${oid}}"` : `
echo "$*" >> "$CALLS"
case "$1 $2 $3" in
  'hosting source github') echo '{"data":{"importId":"import-1"}}' ;;
  'hosting source status') jq -cn --arg status "\${IMPORT_STATUS:-COMPLETED}" --arg hash "\${IMPORT_HASH:-${oid}}" '{data:{importId:"import-1",importType:"GITHUB",status:$status,gitHash:(if $hash == "null" then null else $hash end)}}' ;;
  'hosting deployment publish') echo '{"data":{"deploymentId":"deployment-1"}}' ;;
  'hosting deployment get') jq -cn --arg hash "\${PUBLISH_HASH:-${oid}}" '{data:{deploymentId:"deployment-1",status:"COMPLETED",gitHash:(if $hash == "null" then null else $hash end)}}' ;;
  'hosting app get') jq -cn --arg branch "\${SOURCE_BRANCH:-releases/test}" '{data:{source:"GITHUB",sourceDetails:{repositoryFullName:"Jev-Engineering/TypeCheck",branch:$branch}}}' ;;
  *) exit 91 ;;
esac`;
        writeFileSync(join(dir, name), '#!/usr/bin/env bash\n' + contents + '\n', { mode: 0o755 });
    }
    const calls = join(dir, 'calls');
    for (const overrides of [{}, { IMPORT_HASH: 'null', PUBLISH_HASH: 'null' }, { IMPORT_HASH: 'null', SOURCE_BRANCH: 'main' }, { IMPORT_HASH: commit }, { IMPORT_HASH: 'missing' }, { IMPORT_STATUS: 'FAILED' }, { REF_HASH: commit }, { PUBLISH_HASH: commit }]) {
        writeFileSync(calls, '');
        const r = spawnSync('bash', [resolve('scripts/godaddy-release.sh'), 'ship', commit, '123-1'], { encoding: 'utf8', timeout: 10000,
            env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, APP_ID: 'NODEJS-test', GITHUB_REPOSITORY: spec.repository, CALLS: calls, ...overrides } });
        const success = Object.keys(overrides).length === 0 || overrides.IMPORT_HASH === 'null' && !overrides.SOURCE_BRANCH;
        assert.equal(r.status === 0, success, r.stderr);
        const invoked = readFileSync(calls, 'utf8');
        assert.match(invoked, /source github .*--repo Jev-Engineering\/TypeCheck --branch releases\/test/);
        assert.doesNotMatch(invoked, /source upload/);
        if (!success && !overrides.PUBLISH_HASH) assert.doesNotMatch(invoked, /deployment publish/);
    }
});
