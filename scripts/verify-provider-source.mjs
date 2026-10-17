import { readFileSync } from 'node:fs';
import { verifyProviderSource } from './release-source.mjs';

const [kind, id, repository, branch, oid, head] = process.argv.slice(2);
if (!['import', 'deployment'].includes(kind)) throw new Error('invalid provider operation');
const [result, app] = JSON.parse(readFileSync(0, 'utf8'));
console.log(JSON.stringify(verifyProviderSource(result.data, app.data, { kind, id, repository, branch, oid, head })));
