import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
export interface Release { commit: string; run: string | null; migrate: boolean }
// release.json is written into the deployment archive by the production workflow;
// development and container builds have none and report a null release. `migrate` is set
// only for a release the workflow admitted as an expand-only migration after a confirmed backup.
export async function loadRelease(root: string): Promise<Release | null> {
    try {
        const value = JSON.parse(await readFile(resolve(root, 'release.json'), 'utf8'));
        if (typeof value?.commit !== 'string' || !/^[0-9a-f]{40}$/.test(value.commit)) return null;
        return { commit: value.commit, run: typeof value.run === 'string' && /^[0-9]+-[0-9]+$/.test(value.run) ? value.run : null, migrate: value.migrate === true };
    }
    catch { return null; }
}
export const assetVersion = (release: Release | null) => release ? release.commit.slice(0, 12) : 'dev';
