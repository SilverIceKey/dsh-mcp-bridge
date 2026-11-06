import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const transport=new StdioClientTransport({command:process.execPath,args:[resolve(root,'src/server.js')],env:{...process.env,DSH_BRIDGE_DATA:resolve(root,'.bridge'),DSH_TRANSPORT:'desktop'},stderr:'pipe'});
const client=new Client({name:'desktop-live-review',version:'1.0.0'});
try {await client.connect(transport);console.log(JSON.stringify(await client.callTool({name:process.argv[2],arguments:JSON.parse(process.argv[3])})));}
finally {await client.close();}
