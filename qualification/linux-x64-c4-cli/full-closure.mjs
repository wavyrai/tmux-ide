import {lstatSync,readdirSync,readlinkSync,readFileSync,writeFileSync,realpathSync,openSync,readSync,closeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,resolve} from 'node:path';
const rows=[];function sha(path){const h=createHash('sha256'),fd=openSync(path,'r'),buffer=Buffer.alloc(1024*1024);try{let n;while((n=readSync(fd,buffer,0,buffer.length,null))>0)h.update(buffer.subarray(0,n));return h.digest('hex');}finally{closeSync(fd);}}
function walk(path){const s=lstatSync(path);const row={path,mode:s.mode&0o7777};
 if(s.isSymbolicLink()){row.kind='symlink';row.target=readlinkSync(path);row.resolved=realpathSync(path);if(!row.resolved.startsWith('/work/')&&!row.resolved.startsWith('/inputs/'))throw Error('External payload symlink '+path);}
 else if(s.isDirectory()){row.kind='directory';}
 else if(s.isFile()){row.kind='file';row.bytes=s.size;row.sha256=sha(path);}
 else throw Error('Special file '+path);
 rows.push(row);if(row.kind==='directory')for(const n of readdirSync(path).sort())walk(join(path,n));}
for(const root of ['/work/source','/work/native','/work/native-grid-reference','/inputs'])walk(root);
for(const p of ['/work/host.json','/work/host-inputs.json','/work/artifact-receipt.json'])walk(p);
writeFileSync('/evidence/full-closure.json',JSON.stringify({version:1,rows,performanceQualified:false},null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({records:rows.length,performanceQualified:false}));
