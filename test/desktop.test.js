import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DesktopClient} from '../src/desktop.js';
import {apply} from '../src/desktop-plugin.js';

test('desktop transport registers native workspace/session, routes feedback and protects unrelated sessions',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dsh-desktop-test-')); const calls=[];let dispose;
 const sessionId='test-session'; let running=false, childRunning=false, pendingInput=[], reason={kind:"completed"}; const seen=new Set();
 const ctx={
  on:(event,fn)=>{if(event==='dispose')dispose=fn;},logger:{warn:()=>{}},
  workspaceRegistry:{create:async cwd=>{calls.push(['workspace',cwd]);return {id:'workspace-1'};}},
  get:name=>name==='subagents' ? {listDescendants:async()=>[{id:'child'}]} : undefined,
  agents:{get:id=>id==='child'?{status:childRunning?'running':'idle'}:{inbox:{nextTurn:[],nextStep:[]},session:{snapshotEvents:()=>[...Array.from(seen, rpcId=>({type:'user/message',data:{source:{kind:'user',rpcId}}})),{type:'turn/end',data:{reason}}]}}},llm:{resolveCallConfig:async s=>calls.push(['model-validate',s])},
  sessionController:{
   create:async r=>{calls.push(['create',r]);return {sessionId:r.sessionId};},
   resolveAgent:async()=>({agent:{model:{select:s=>calls.push(['model',s])}}}),
   rename:async r=>calls.push(['rename',r]),
   state:async()=>({running,queue:[],pendingInput,cursor:5}),
   prompt:async r=>{if(!seen.has(r.requestId)){seen.add(r.requestId);calls.push(['prompt',r]);}return {accepted:true};},
   events:async r=>({items:[{type:'tool/call',tool:'subagent'}],request:r}),
   cancel:async r=>({accepted:true,sessionId:r.sessionId})
  }
 };
 try {
  await apply(ctx,{dataDir:root}); const client=new DesktopClient(root);
  assert.equal((await client.call('bridge/ping',{})).transport,'desktop');
  const e=JSON.parse(await readFile(join(root,'desktop-endpoint.json'),'utf8'));
  assert.equal((await fetch(e.url+'/rpc',{method:'POST',body:'{}'})).status,403);
  const created=await client.call('session/create',{cwd:root,sessionId,title:'Visible task'});
  assert.equal(created.workspaceId,'workspace-1');
  assert.deepEqual(calls.find(c=>c[0]==='create')[1],{workspaceId:'workspace-1',sessionId});
  assert.equal(calls.find(c=>c[0]==='rename')[1].title,'Visible task');
  await client.call('session/create',{cwd:root,sessionId});
  assert.equal(calls.filter(c=>c[0]==='create').length,1);
  const req={sessionId,requestId:'review-1',content:[{type:'text',text:'review'}],mode:'queue'};
  await client.call('session/prompt',req);await client.call('session/prompt',req);
  assert.equal(calls.filter(c=>c[0]==='prompt').length,1);
  assert.equal((await client.call('session/state',{sessionId})).status,'awaiting_review');
  childRunning=true;assert.equal((await client.call('session/state',{sessionId})).status,'running');
  childRunning=false;reason={kind:'error'};assert.equal((await client.call('session/state',{sessionId})).status,'failed');
  pendingInput=['approval'];assert.equal((await client.call('session/state',{sessionId})).status,'input_required');pendingInput=[];reason={kind:'completed'};
  running=true;await client.call('session/prompt',req);assert.equal(calls.filter(c=>c[0]==='prompt').length,1);assert.equal((await client.call('session/state',{sessionId})).status,'running');
  await assert.rejects(client.call('session/prompt',{...req,requestId:'review-2'}),/busy/);
  await assert.rejects(client.call('session/state',{sessionId:'unrelated'}),/not owned/);
  const history=await client.call('session/events',{address:{kind:'session',sessionId},beforeSeq:3});
  assert.equal(history.request.beforeSeq,3);
  await assert.rejects(client.call('unsafe/method',{sessionId}),/Unsupported/);
  await dispose();dispose=undefined;
  await assert.rejects(client.call('bridge/ping',{}),/No headless fallback/);
 }finally{if(dispose)await dispose();await rm(root,{recursive:true,force:true});}
});
