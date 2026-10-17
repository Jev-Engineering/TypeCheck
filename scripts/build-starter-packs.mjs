import { mkdir,writeFile } from 'node:fs/promises';
import { starterPack,STARTER_PACKS } from '../dist/server/pack-starters.js';
import { validatePack } from '../dist/server/packs.js';
import { createHash } from 'node:crypto';
await mkdir('starters',{recursive:true});
const checksums=[];
for(const starter of STARTER_PACKS) {const p=await starterPack(process.cwd(),starter.id);await validatePack(p);const bytes=JSON.stringify(p,null,2)+'\n',file=p.id+'.typecheck.json';await writeFile('starters/'+file,bytes);checksums.push(createHash('sha256').update(bytes).digest('hex')+'  '+file);console.log(p.id+': '+p.components.length+' components, '+p.assets.length+' original images; no model evaluation');}
await writeFile('starters/SHA256SUMS',checksums.join('\n')+'\n');
