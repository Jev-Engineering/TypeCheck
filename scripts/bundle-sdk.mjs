import {build} from 'esbuild';
import {readFile,writeFile,readdir} from 'node:fs/promises';
await build({stdin:{contents:'export { DiscordSDK } from "@discord/embedded-app-sdk";',resolveDir:process.cwd(),sourcefile:'discord-sdk-entry.js'},outfile:'dist/activity/vendor/discord-sdk.js',bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,legalComments:'eof'});
console.log('Official Discord Embedded App SDK bundled.');
// Preserve full notices for the SDK and its browser dependencies alongside the bundle.
const packages=['@discord/embedded-app-sdk','big-integer','decimal.js-light','eventemitter3','lodash.transform','uuid','zod'];
const notices=[];
for(const name of packages){
  const dir=`node_modules/${name}`;
  const pkg=JSON.parse(await readFile(`${dir}/package.json`,'utf8'));
  const files=(await readdir(dir)).filter(f=>/^licen[cs]e(?:\.|$)/i.test(f));
  if(!files.length) throw new Error(`Missing license notice for ${name}`);
  notices.push(`${name}@${pkg.version} (${pkg.license})\n`+(await Promise.all(files.map(f=>readFile(`${dir}/${f}`,'utf8')))).join('\n'));
}
await writeFile('dist/activity/vendor/THIRD_PARTY_NOTICES.txt',notices.join('\n\n--------------------\n\n'));
