import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

const cwd=resolve('.local',`live-${Date.now()}`);await mkdir(cwd,{recursive:true});
const client=new Client({name:'codex-live-reviewer',version:'1.0.0'});
const transport=new StdioClientTransport({command:process.execPath,args:[resolve('src/server.js')],env:{...process.env,DSH_BRIDGE_DATA:resolve('.bridge')}});
const call=async(name,args)=>{const result=await client.callTool({name,arguments:args});if(result.isError)throw Error(result.content[0].text);return JSON.parse(result.content[0].text);};
async function wait(taskId){
  const until=Date.now()+240000;
  while(Date.now()<until){const result=await call('dsh_status',{taskId});if(result.state?.status==='failed')throw Error(JSON.stringify(result.state));if(result.state?.status==='awaiting_review')return result;await new Promise(r=>setTimeout(r,1500));}
  throw Error('Timed out; inspect the task before resubmitting');
}
try {
  await client.connect(transport);
  const task=await call('dsh_dispatch',{cwd,objective:'Create result.txt containing exactly FIRST_PASS. Use one subagent to independently verify the file contents. Do not change any other files. Report the verification.',acceptance:'result.txt contains FIRST_PASS; a real subagent verifies it.',allowTeam:true});
  console.log(JSON.stringify({stage:'dispatched',taskId:task.id,cwd}));
  assert.equal(task.status,'submitted');
  await wait(task.id);assert.equal((await readFile(resolve(cwd,'result.txt'),'utf8')).trim(),'FIRST_PASS');
  const history=await call('dsh_history',{taskId:task.id});
  assert.ok(history.runs[0].events.some(e=>e.type==='tool_call'&&e.tool==='subagent'),'A real subagent must be invoked');
  await writeFile(resolve(cwd,'evidence.json'),JSON.stringify(history,null,2));
  console.log('First execution and file verification passed');
  await call('dsh_feedback',{taskId:task.id,requestId:randomUUID(),feedback:'Review: change result.txt to exactly REVIEW_PASSED. Do not delegate this small change. Report completion.'});
  await wait(task.id);assert.equal((await readFile(resolve(cwd,'result.txt'),'utf8')).trim(),'REVIEW_PASSED');
  const final=await call('dsh_history',{taskId:task.id});
  assert.equal(final.runs[0].final.sessionId,final.runs[1].final.sessionId,'Feedback must continue the same dsh session');
  await writeFile(resolve(cwd,'evidence.json'),JSON.stringify(final,null,2));
  console.log(JSON.stringify({stage:'passed',taskId:task.id,cwd,runs:final.runs.length}));
} finally {await client.close();}
