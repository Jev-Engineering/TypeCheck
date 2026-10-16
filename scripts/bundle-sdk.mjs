import {build} from 'esbuild';
await build({stdin:{contents:'export { DiscordSDK } from "@discord/embedded-app-sdk";',resolveDir:process.cwd(),sourcefile:'discord-sdk-entry.js'},outfile:'dist/activity/vendor/discord-sdk.js',bundle:true,format:'esm',platform:'browser',target:'es2022',minify:true,legalComments:'eof'});
console.log('Official Discord Embedded App SDK bundled.');
