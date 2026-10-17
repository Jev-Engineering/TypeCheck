// Produce a repository-backed equivalent of the old archive: approved source + release.json.
// The provider only accepts a branch, so never import moving main or overwrite a release ref.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

export function releaseSpec(repository, commit, run, migrate) {
    assert.match(repository ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
    assert.match(commit ?? '', /^[a-f0-9]{40}$/);
    assert.match(run ?? '', /^[0-9]+-[0-9]+$/);
    assert.equal(typeof migrate, 'boolean');
    return { repository, commit, branch: `releases/${run}-${commit}-${migrate ? 'migrate' : 'no-migrate'}`,
        content: JSON.stringify({ commit, run, migrate }) + '\n' };
}

export function verifyArtifact(spec, artifact, originalTree, releaseTree) {
    assert.match(artifact.sha ?? '', /^[a-f0-9]{40}$/);
    assert.equal(artifact.commit?.verification?.verified, true, 'release commit must be signed');
    assert.deepEqual(artifact.parents?.map(p => p.sha), [spec.commit], 'release parent must be the approved candidate');
    assert.equal(originalTree.truncated, false); assert.equal(releaseTree.truncated, false);
    assert.ok(!originalTree.tree.some(e => e.path === 'release.json'), 'candidate must not contain release metadata');
    const metadata = releaseTree.tree.filter(e => e.path === 'release.json');
    const blob = createHash('sha1').update(`blob ${Buffer.byteLength(spec.content)}\0`).update(spec.content).digest('hex');
    assert.equal(metadata.length, 1);
    assert.deepEqual({ path: metadata[0].path, mode: metadata[0].mode, type: metadata[0].type, sha: metadata[0].sha },
        { path: 'release.json', mode: '100644', type: 'blob', sha: blob });
    const entries = tree => tree.filter(e => e.path !== 'release.json').map(({ path, mode, type, sha }) => ({ path, mode, type, sha })).sort((a, b) => a.path.localeCompare(b.path));
    assert.deepEqual(entries(releaseTree.tree), entries(originalTree.tree), 'release changed application source');
}

export function createReleaseSource(spec, api) {
    const root = `repos/${spec.repository}`;
    const original = api(`${root}/git/trees/${spec.commit}`);
    assert.equal(original.truncated, false);
    assert.ok(!original.tree.some(e => e.path === 'release.json'), 'candidate must not contain release metadata');
    // Creating a fresh ref fails on collision; never force-update an existing release branch.
    api(`${root}/git/refs`, { ref: `refs/heads/${spec.branch}`, sha: spec.commit });
    const created = api('graphql', {
        query: 'mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }',
        variables: { input: { branch: { repositoryNameWithOwner: spec.repository, branchName: spec.branch },
            expectedHeadOid: spec.commit, message: { headline: `Release ${spec.commit}` },
            fileChanges: { additions: [{ path: 'release.json', contents: Buffer.from(spec.content).toString('base64') }] } } }
    });
    assert.ok(!created.errors, 'release commit creation failed');
    const oid = created.data?.createCommitOnBranch?.commit?.oid;
    assert.match(oid ?? '', /^[a-f0-9]{40}$/);
    const artifact = api(`${root}/commits/${oid}`);
    verifyArtifact(spec, artifact, original, api(`${root}/git/trees/${oid}`));
    assert.equal(api(`${root}/git/ref/heads/${spec.branch}`).object?.sha, oid, 'release branch changed');
    return { branch: spec.branch, oid };
}

// GoDaddy omits import gitHash and uses a provider-side hash for deployments.
// Bind GitHub identity through the signed branch, and provider identity through
// the operation ID and any hash supplied by that operation's initial receipt.
export function verifyProviderSource(result, app, expected) {
    assert.equal(result.status, 'COMPLETED', 'provider operation incomplete');
    assert.equal(result[expected.kind === 'import' ? 'importId' : 'deploymentId'], expected.id, 'provider operation identity changed');
    if (expected.kind === 'import') assert.equal(result.importType, 'GITHUB', 'expected GitHub import');
    assert.equal(app.source, 'GITHUB', 'repository connection changed');
    assert.equal(app.sourceDetails?.repositoryFullName, expected.repository, 'source repository changed');
    assert.equal(app.sourceDetails?.branch, expected.branch, 'source branch changed');
    assert.equal(expected.head, expected.oid, 'release branch changed');
    if (result.gitHash !== null && result.gitHash !== undefined) assert.match(result.gitHash, /^[a-f0-9]{40}$/, 'invalid provider hash');
    if (expected.receiptHash) {
        assert.match(expected.receiptHash, /^[a-f0-9]{40}$/, 'invalid provider receipt hash');
        assert.equal(result.gitHash, expected.receiptHash, 'provider operation hash changed');
    }
    return { githubSource: expected.oid, providerHash: result.gitHash ?? null, provenance: 'signed_branch_and_provider_source', receiptHashVerified: Boolean(expected.receiptHash) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [commit, run, migration = 'no-migrate'] = process.argv.slice(2);
    assert.ok(['migrate', 'no-migrate'].includes(migration));
    const spec = releaseSpec(process.env.GITHUB_REPOSITORY, commit, run, migration === 'migrate');
    const api = (endpoint, body) => JSON.parse(execFileSync('gh', ['api', endpoint, ...(body ? ['--input', '-'] : [])],
        { encoding: 'utf8', input: body ? JSON.stringify(body) : undefined, timeout: 60000, maxBuffer: 4 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }));
    console.log(JSON.stringify(createReleaseSource(spec, api)));
}
