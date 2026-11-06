import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { DshClient } from './dsh.js';
import { HeadlessClient } from './headless.js';
import { DesktopClient } from './desktop.js';

const transportName = process.env.DSH_TRANSPORT || 'desktop';
if (!['desktop','headless','http'].includes(transportName)) throw Error('Invalid DSH_TRANSPORT');
const clients = {desktop:new DesktopClient(),headless:new HeadlessClient(),http:new DshClient()};
const clientFor = task => clients[task.transport || 'headless'];
const server = new McpServer({name:'dsh-mcp-bridge',version:'0.2.0'});
const directory = resolve(process.env.DSH_BRIDGE_DATA || '.bridge');
const id = z.string().uuid();
async function save(task) {
  await mkdir(directory,{recursive:true});
  const file = join(directory,`${task.id}.json`), temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp,JSON.stringify(task,null,2)); await rename(temp,file);
}
async function load(taskId) { return JSON.parse(await readFile(join(directory,`${taskId}.json`),'utf8')); }
function tool(name, description, schema, handler) {
  server.tool(name,description,schema,async args => {
    try { return {content:[{type:'text',text:JSON.stringify(await handler(args))}]}; }
    catch(error) { return {isError:true,content:[{type:'text',text:error.message}]}; }
  });
}
tool('dsh_dispatch','Assign work to dsh. Returns promptly; execution is not review approval. Save the task ID even if submission is uncertain.',{
  cwd:z.string(), objective:z.string().min(1), acceptance:z.string().min(1), allowTeam:z.boolean().default(true)
},async args => {
  if (!isAbsolute(args.cwd)) throw new Error('cwd must be an absolute path');
  const task = {id:randomUUID(),requestId:randomUUID(),...args,transport:transportName,status:'creating',createdAt:new Date().toISOString()};
  await save(task);
  const client = clientFor(task);
  try {
    const session = await client.call('session/create',{cwd:args.cwd,sessionId:task.id,title:'Codex · '+args.objective.replace(/\s+/g,' ').slice(0,60)});
    task.sessionId = session.sessionId; task.status = 'submitting'; await save(task);
    await client.call('session/prompt',{sessionId:task.sessionId,requestId:task.requestId,mode:'queue',content:[{type:'text',text:
      `You are the executor; Codex is the project lead and reviewer.\nTask: ${args.objective}\nAcceptance criteria: ${args.acceptance}\n${args.allowTeam ? 'You may use your own subagents as needed.' : 'Perform the work without spawning subagents.'}\nWork only within the assigned scope. Report changed files, checks and results, and unresolved issues. Do not claim Codex review approval. Do not publish or deploy unless explicitly requested.`}]});
    task.status = 'submitted';
  } catch(error) { task.status = 'submission_unknown'; task.error = error.message; }
  await save(task); return task;
});
tool('dsh_status','Read persisted task and live dsh state; inspect pending approvals and questions in dsh.',{taskId:id},async ({taskId}) => {
  const task = await load(taskId);
  return {task, state:task.sessionId ? await clientFor(task).call('session/state',{sessionId:task.sessionId}) : null};
});
tool('dsh_history','Read execution evidence, including tool results. Page backward with beforeSeq when necessary.',{
  taskId:id, beforeSeq:z.number().int().nonnegative().optional()
},async ({taskId,beforeSeq}) => {
  const task = await load(taskId);
  if (!task.sessionId) throw new Error('No session recorded');
  return clientFor(task).call('session/events',{address:{kind:'session',sessionId:task.sessionId},maxMessages:30,...beforeSeq === undefined ? {} : {beforeSeq}});
});
tool('dsh_feedback','Send review findings or follow-up instructions to the same executor session. Use a stable requestId to retry safely.',{
  taskId:id, requestId:id, feedback:z.string().min(1)
},async ({taskId,requestId,feedback}) => {
  const task = await load(taskId);
  if (!task.sessionId) throw new Error('No session recorded');
  return clientFor(task).call('session/prompt',{sessionId:task.sessionId,requestId,mode:'queue',content:[{type:'text',text:`Codex review feedback:\n${feedback}`}]});
});
tool('dsh_cancel','Cancel the active turn. Queued messages and child work may remain; inspect state afterward.',{taskId:id},async ({taskId}) => {
  const task = await load(taskId);
  if (!task.sessionId) throw new Error('No session recorded');
  return clientFor(task).call('session/cancel',{sessionId:task.sessionId});
});
await server.connect(new StdioServerTransport());
process.on('SIGINT', () => {Object.values(clients).forEach(client => client.close()); process.exit(0);});
process.stdin.on('end', () => {Object.values(clients).forEach(client => client.close());});
