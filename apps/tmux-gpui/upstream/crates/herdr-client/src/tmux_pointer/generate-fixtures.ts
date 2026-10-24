import {createMouseOwner} from '../../../../../../../apps/tmux-gpui/bridge/mouse.ts';
import {routeWheel} from '../../../../../../../apps/tmux-gpui/bridge/wheel.ts';
import {blankTerminalReplicaSnapshot} from '../../../../../../../packages/core/src/terminal-replica.ts';
import {writeFileSync} from 'node:fs';
const base=blankTerminalReplicaSnapshot(1,1);
const snapshot={...base,cols:16384,rows:16384,modes:{...base.modes,mouseProtocol:'any' as const,mouseEncoding:'sgr' as const}};
const pointers=[];
for(const action of ['down','drag','up','move']){
 const owner=createMouseOwner();const data={action:'down',gesture:1,row:2,col:4,button:2,shift:false,alt:true,control:true,protocol:'any',encoding:'sgr',cols:16384,rows:16384};
 if(action==='drag'||action==='up')owner.route(snapshot,'scope',{kind:'mouse',data});
 pointers.push({action,expected:owner.route(snapshot,'scope',{kind:'mouse',data:{...data,action,button:action==='move'?null:2}})});
}
const wheels=[128,-128,1,-1].map(lines=>({lines,expected:routeWheel(snapshot,0,{kind:'wheel',data:{lines,row:16383,col:16383,shift:false,alt:true,control:true}})}));
writeFileSync(new URL('./vectors.json',import.meta.url),JSON.stringify({pointers,wheels}));
