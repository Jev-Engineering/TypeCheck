/** Optional source normalization using the project's installed TypeScript printer. */
import ts from 'typescript';
import {readdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const printer=ts.createPrinter({newLine:ts.NewLineKind.LineFeed,removeComments:false});
async function visit(dir){for(const item of await readdir(dir,{withFileTypes:true})){const file=join(dir,item.name);if(item.isDirectory())await visit(file);else if(file.endsWith('.ts')){const source=ts.createSourceFile(file,await readFile(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);await writeFile(file,printer.printFile(source));}}}
for(const dir of ['server','shared','activity/src','tests'])await visit(dir);
