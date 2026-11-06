import {createServer} from 'node:http';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {mkdir, readFile, writeFile, rename, unlink} from 'node:fs/promises';
import {join, isAbsolute} from 'node:path';

export const inject = ['sessionController', 'workspaceRegistry', 'agents', 'llm'];
export async function apply(ctx, config) {
  const root = config.dataDir;
  if (!root || !isAbsolute(root)) throw Error('desktop bridge dataDir must be absolute');
  await mkdir(root, {recursive:true});
  const ownedFile = join(root, 'desktop-sessions.json');
  let owned;
  try { owned = new Set(JSON.parse(await readFile(ownedFile, 'utf8'))); }
  catch (e) { if(e.code !== 'ENOENT') throw e; owned = new Set(); }
  const token = randomBytes(32).toString('hex');
  const endpointFile = join(root, 'desktop-endpoint.json');
  let tail = Promise.resolve();
  const serial = fn => {const p=tail.then(fn); tail=p.catch(()=>{}); return p;};
  const saveOwned = async () => {
    await writeFile(ownedFile+'.tmp', JSON.stringify([...owned]));
    await rename(ownedFile+'.tmp', ownedFile);
  };
  const controller = ctx.sessionController;
  async function activity(sessionId, signal) {
    const state = await controller.state({sessionId},signal);
    const service = ctx.get?.('subagents');
    const descendants = service ? await service.listDescendants(sessionId,signal) : [];
    const children = descendants.filter(e=>e.kind !== 'diagnostic').map(e=>({id:e.id,running:ctx.agents.get(e.id)?.status === 'running'}));
    const agent = ctx.agents.get(sessionId);
    const lastEnd = agent?.session.snapshotEvents().findLast(e=>e.type === 'turn/end');
    const busy = state.running || state.queue?.length > 0 || children.some(e=>e.running);
    return {...state,children,lastTurnReason:lastEnd?.data.reason,
      status:state.pendingInput.length ? 'input_required' : busy ? 'running' :
        lastEnd?.data.reason?.kind && lastEnd.data.reason.kind !== 'completed' ? 'failed' : 'awaiting_review'};
  }
  function submitted(sessionId, requestId) {
    const agent = ctx.agents.get(sessionId);
    const matches = m => m.source?.kind === 'user' && m.source.rpcId === requestId;
    return agent && (agent.inbox.nextTurn.some(matches) || agent.inbox.nextStep.some(matches) ||
      agent.session.snapshotEvents().some(e=>e.type === 'user/message' && matches(e.data)));
  }
  async function call(method, r, signal) {
    if (method === 'bridge/ping') return {transport:'desktop', protocol:1};
    if (method === 'session/create') return serial(async () => {
      if (!isAbsolute(r.cwd) || !/^[a-zA-Z0-9-]+$/.test(r.sessionId)) throw Error('Invalid cwd/sessionId');
      if (owned.has(r.sessionId)) return {sessionId:r.sessionId};
      const workspace = await ctx.workspaceRegistry.create(r.cwd);
      const result = await controller.create({workspaceId:workspace.id, sessionId:r.sessionId});
      // Claim before configuring, so a partial setup remains inspectable and retryable.
      owned.add(result.sessionId); await saveOwned();
      const found = await controller.resolveAgent(result.sessionId);
      if (found.error) throw found.error;
      const selection = {provider:config.provider || 'deepseek-account', model:config.model || 'deepseek-flash'};
      await ctx.llm.resolveCallConfig(selection);
      found.agent.model.select(selection); // Session-local: do not change the user's default model.
      await controller.rename({sessionId:result.sessionId,title:r.title || 'Codex 派发任务'});
      return {...result,workspaceId:workspace.id,transport:'desktop'};
    });
    const sessionId = r.sessionId || r.address?.sessionId;
    if (!owned.has(sessionId)) throw Error('Session is not owned by this bridge');
    if (method === 'session/prompt') return serial(async () => {
      // Native prompt admission deduplicates requestId in the persisted conversation.
      if (submitted(sessionId,r.requestId)) return {accepted:true,duplicate:true};
      const state = await activity(sessionId,signal);
      if (state.status === 'running') throw Error('Executor busy; wait before sending feedback');
      return controller.prompt({...r,clientTimeZone:'Asia/Shanghai'},signal);
    });
    if (method === 'session/state') {
      const state = await activity(sessionId,signal);
      return {...state, dshSessionId:sessionId, transport:'desktop', review:'not_reviewed'};
    }
    if (method === 'session/events') return controller.events(r,signal);
    if (method === 'session/cancel') return controller.cancel({sessionId});
    throw Error('Unsupported desktop bridge method');
  }
  const sockets = new Set();
  const server = createServer(async (req,res) => {
    const supplied = Buffer.from(req.headers.authorization || '');
    const expected = Buffer.from('Bearer '+token);
    if(req.method!=='POST' || req.url!=='/rpc' || supplied.length!==expected.length || !timingSafeEqual(supplied,expected)) {
      res.writeHead(403); res.end(); return;
    }
    const abort = new AbortController();
    res.on('close',()=>abort.abort());
    try {
      let size=0; const chunks=[];
      for await (const chunk of req) {size+=chunk.length; if(size>1024*1024)throw Error('Request too large'); chunks.push(chunk);}
      const {method,request} = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const value = await call(method,request || {},abort.signal);
      res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({ok:true,value}));
    } catch(e) {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:false,error:e.message}));}
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  server.requestTimeout=30000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  await writeFile(endpointFile+'.tmp',JSON.stringify({url:'http://127.0.0.1:'+server.address().port,token,protocol:1}));
  await rename(endpointFile+'.tmp',endpointFile);
  ctx.on('dispose',async()=>{
    for(const socket of sockets)socket.destroy();
    await new Promise(resolve=>server.close(resolve));
    try {if(JSON.parse(await readFile(endpointFile,'utf8')).token===token)await unlink(endpointFile);}catch(e){if(e.code!=='ENOENT')ctx.logger.warn(e.message);}
  });
}
