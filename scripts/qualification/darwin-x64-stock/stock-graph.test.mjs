import test from 'node:test';
import assert from 'node:assert/strict';
import {validateStockDependencies} from './stock-graph.mjs';
const files={'/owned/source/tmux':'x','/owned/dependencies/a/lib/libevent.dylib':'a','/owned/dependencies/b/lib/ncurses.dylib':'b','/owned/dependencies/c/lib/utf8.dylib':'c'};
const manifest={files:{'lib/libevent.dylib':'a','lib/ncurses.dylib':'b','lib/utf8.dylib':'c'}};
test('source stock accepts only three retained library names from private staging',()=>validateStockDependencies({files},'/owned/source/tmux','/owned/bundle','unpatched-source',manifest));
test('host library substitution is refused even with matching basename',()=>{
 const changed={...files};delete changed['/owned/dependencies/a/lib/libevent.dylib'];changed['/usr/local/lib/libevent.dylib']='a';
 assert.throws(()=>validateStockDependencies({files:changed},'/owned/source/tmux','/owned/bundle','unpatched-source',manifest),/Unexpected link-time/);
});
test('unknown additional runtime dependency is refused',()=>assert.throws(()=>validateStockDependencies({files:{...files,'/owned/dependencies/d/lib/other.dylib':'d'}},'/owned/source/tmux','/owned/bundle','unpatched-source',manifest),/Unexpected runtime/));
test('host candidate still refuses basename collisions',()=>assert.throws(()=>validateStockDependencies({files:{...files,'/another/ncurses.dylib':'d'}},'/owned/source/tmux','/owned/bundle','host-stock',manifest),/collision/));
