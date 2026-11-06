import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {DshClient} from '../src/dsh.js';

test('MCP handshake, tool discovery, input validation and missing credential errors',async () => {
  const transport = new StdioClientTransport({command:process.execPath,args:['src/server.js'],env:{...process.env,DSH_URL:'',DSH_TOKEN:''}});
  const client = new Client({name:'test',version:'1.0.0'});
  try {
    await client.connect(transport);
    const {tools} = await client.listTools();
    assert.equal(tools.length,5);
    const bad = await client.callTool({name:'dsh_status',arguments:{taskId:'../../escape'}});
    assert.equal(bad.isError,true);
    const result = await client.callTool({name:'dsh_dispatch',arguments:{cwd:'.',objective:'test',acceptance:'test'}});
    assert.equal(result.isError,true);
  } finally {await client.close();}
});
test('missing credentials and remote endpoints are rejected',async () => {
  await assert.rejects(new DshClient('', '').connect(),/DSH_URL/);
  await assert.rejects(new DshClient('http://example.com','token').connect(),/Only local/);
});
