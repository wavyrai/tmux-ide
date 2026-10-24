import {writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {blankTerminalReplicaSnapshot} from '../../../../../../../../packages/core/src/terminal-replica.ts';
import {encodeCompactSemanticTerminalUpdate} from '../../../../../../../../packages/core/src/terminal-delivery.ts';
import {resolveKittyImagePlacements} from '../../../../../../../../packages/core/src/kitty-placeholders.ts';
import {TerminalGraphicsStateSchemaZ} from '../../../../../../../../packages/contracts/src/terminal-graphics.ts';
const P=String.fromCodePoint(0x10eeee),D=['̅','̍','̎','̐'];const bytes=Buffer.from(Array.from({length:64},(_,i)=>i));
const digest=createHash('sha256').update(bytes).digest('hex').slice(0,32);
const image={imageId:5,digest,format:'rgba',width:4,height:4,bytes:64,placeholder:{columns:4,rows:4}};
const cases=[];
for(const kind of ['merged','high-byte','unknown']){
 const snapshot=blankTerminalReplicaSnapshot(4,3); const cell=(grapheme:string,id=5)=>({grapheme,width:1,foreground:{kind:'indexed',index:id},background:{kind:'default'},attributes:0});
 const grid=[['a',P+D[0]+D[0],P,'b'],['a',P+D[1]+D[0],P,'b'],[P+D[3]+D[1],'c','c','c']].map(row=>({wrapped:false,cells:row.map(text=>cell(text))}));
 let registry={...image};
 if(kind==='high-byte'){registry={...image,imageId:0x1123456};grid[0].cells[1]={...cell(P+D[0]+D[0]+D[1]),foreground:{kind:'rgb',value:0x123456}} as any;grid[0].cells[2]={...cell(P),foreground:{kind:'rgb',value:0x123456}} as any;}
 if(kind==='unknown')registry={...image,imageId:123};
 const actual={...snapshot,grid,placements:[{id:'fixture-widget',kind:'widget',row:0,column:0,rows:1,columns:1,contentDigest:'widget-fixture'}]};
 const state=TerminalGraphicsStateSchemaZ.parse({revision:1,images:[registry],placements:[],cellPixels:true,preciseCellPixels:true});
 cases.push({kind,wire:Buffer.from(encodeCompactSemanticTerminalUpdate({frame:'seed',revision:1,snapshot:actual})).toString(),state,expected:resolveKittyImagePlacements(actual.grid,state),bytes:bytes.toString('base64')});
}
writeFileSync(new URL('./vectors.json',import.meta.url),JSON.stringify({source:'Production TS compact encoder, terminal graphics schema and Kitty placeholder resolver',cases},null,2)+'\n');
