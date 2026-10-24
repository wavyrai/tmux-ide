// Run with Node 24: node --experimental-strip-types <this file>
import {writeFileSync} from 'node:fs';
import {PaneStreamServerFrameSchemaZ} from '../../../../../../../../packages/contracts/src/pane-stream.ts';
const layout=(width=2,border='off')=>({type:'layout',semanticWindowId:'window-a',windowName:'test',currentWindow:true,cols:width*2+1,rows:border==='off'?2:3,zoomed:false,paneBorderStatus:border,modeKeys:'vi',panes:[{pane:'left',left:0,top:0,width,height:border==='off'?2:3,active:false},{pane:'right',left:width+1,top:0,width,height:border==='off'?2:3,active:true}]});
const snapshot={type:'layout-snapshot',topologyEpoch:1,layouts:[layout()],windowLinks:{liveSessionId:`live-session.${'a'.repeat(20)}`,linkRevision:1,activeLinkId:`window-link.${'a'.repeat(32)}`,links:[{linkId:`window-link.${'a'.repeat(32)}`,semanticWindowId:'window-a',displayIndex:0}]}};
const frames=[layout(),layout(3),layout(2,'top'),layout(2,'bottom'),snapshot].map(v=>PaneStreamServerFrameSchemaZ.parse(v));
writeFileSync(new URL('./fixtures.json', import.meta.url),JSON.stringify({source:'window-presentation.test.ts layout(width), pane-stream.test.ts window-link snapshot; validated by PaneStreamServerFrameSchemaZ',frames},null,2)+'\n');
