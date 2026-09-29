// Resolve staged import names only. Never evaluate the referenced workload/product modules.
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,statSync,realpathSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createRequire,isBuiltin} from 'node:module';
const overlay=realpathSync(process.argv[2]),source=realpathSync(process.argv[3]);
const ts=createRequire(source+'/package.json')('typescript');
let imports=0,files=0;
for(const lane of ['cpu','idle','parser','metadata','tail']){
 for(const name of readdirSync(`${overlay}/${lane}`)){
  if(!/\.(?:mjs|ts)$/.test(name))continue;
  const path=`${overlay}/${lane}/${name}`,text=readFileSync(path,'utf8'),req=createRequire(path);files++;
  const ast=ts.createSourceFile(path,text,ts.ScriptTarget.Latest,true);
  for(const statement of ast.statements){
   if(!ts.isImportDeclaration(statement)&&!ts.isExportDeclaration(statement))continue;
   if(!statement.moduleSpecifier||!ts.isStringLiteral(statement.moduleSpecifier))continue;
   const name=statement.moduleSpecifier.text;if(isBuiltin(name))continue;
   const target=name.startsWith('.')||name.startsWith('/')?resolve(dirname(path),name):req.resolve(name);
   assert(statSync(target).isFile(),`Missing import ${name} from ${path}`);
   const actual=realpathSync(target);assert(actual.startsWith(source+'/')||actual.startsWith(overlay+'/'),`Escaping import ${name}`);imports++;
  }
 }
}
assert(imports>35 && files>15);
console.log(JSON.stringify({stagedFiles:files,resolvedImports:imports,evaluatedProductModules:0,scope:'Source/import-root check; actual x64 artifact import admission remains required'}));
