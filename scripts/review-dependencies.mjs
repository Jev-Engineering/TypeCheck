import {readFile,writeFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
const lock=JSON.parse(await readFile('package-lock.json','utf8'));
const reviewed=new Set(['MIT','Apache-2.0','ISC','Unlicense','0BSD','LGPL-3.0-or-later','Apache-2.0 AND LGPL-3.0-or-later','Apache-2.0 AND LGPL-3.0-or-later AND MIT']);
const packages=Object.entries(lock.packages).filter(([path])=>path).map(([path,p])=>({package:path.replace(/^node_modules\//,''),version:p.version,license:p.license??'UNKNOWN',optional:!!p.optional,dev:!!p.dev}));
await mkdir('evidence',{recursive:true});
await writeFile('evidence/dependency-licenses.json',JSON.stringify(packages,null,2)+'\n');
assert.ok(packages.every(p=>reviewed.has(p.license)),'New/unknown license requires review in docs/DEPENDENCIES.md');
console.log(`Reviewed ${packages.length} lockfile license declarations; native LGPL components require retained notices and distribution review.`);
