import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';

export class DesktopClient {
  constructor(root=resolve(process.env.DSH_BRIDGE_DATA || '.bridge')) {this.root=root;}
  async call(method,request) {
    let endpoint;
    try {endpoint=JSON.parse(await readFile(join(this.root,'desktop-endpoint.json'),'utf8'));}
    catch(e) {throw Error('DSH desktop bridge is unavailable. Open DeepSeek Harness with the desktop bridge plugin enabled. No headless fallback was started.',{cause:e});}
    const url=new URL(endpoint.url);
    if(url.protocol!=='http:' || url.hostname!=='127.0.0.1' || url.username || url.password || endpoint.protocol!==1 || !/^[a-f0-9]{64}$/.test(endpoint.token))throw Error('Invalid desktop bridge endpoint');
    let res;
    try {res=await fetch(new URL('/rpc',url),{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:'Bearer '+endpoint.token},body:JSON.stringify({method,request}),signal:AbortSignal.timeout(30000)});}
    catch(e) {throw Error('DSH desktop connection failed; check the task state before retrying. No automatic retry was performed.',{cause:e});}
    if(!res.ok)throw Error('DSH desktop bridge rejected request (HTTP '+res.status+')');
    const data=await res.json();
    if(!data.ok)throw Error(data.error || 'DSH desktop request failed');
    return data.value;
  }
  close() {}
}
