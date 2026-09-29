import {realpathSync,accessSync,constants,statSync} from 'node:fs';
import {resolve,isAbsolute} from 'node:path';import {fileURLToPath} from 'node:url';
export function resolveChildExecutable(executable,options={},parent={cwd:process.cwd(),env:process.env}){
 const cwd=options.cwd instanceof URL?fileURLToPath(options.cwd):resolve(parent.cwd,options.cwd??'.');
 const env=options.env??parent.env;
 const paths=executable.includes('/')?[resolve(cwd,executable)]:(env.PATH??'/usr/bin:/bin').split(':').map(p=>resolve(cwd,p||'.',executable));
 for(const path of paths){try{accessSync(path,constants.X_OK);if(!statSync(path).isFile())continue;return realpathSync(path);}catch{}}
 return null;
}
