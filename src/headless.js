import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir,readFile,writeFile,rename,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

export class HeadlessClient {
  constructor() {
    this.root=resolve(process.env.DSH_BRIDGE_DATA || '.bridge');
    this.active=new Map();
    this.exe=process.env.DSH_DESKTOP_EXE || join(process.env.LOCALAPPDATA || '', 'Programs','DeepSeek Harness','DeepSeek Harness.exe');
    this.cli=join(this.exe,'..','resources','app.asar','dsh','node_modules','@deepseek-ai','dsh-desktop-host','lib','cli.js');
    this.patch=fileURLToPath(new URL('../config/headless.yml',import.meta.url));
  }
  file(id) {if(!/^[a-zA-Z0-9-]+$/.test(id))throw Error('Invalid session ID');return join(this.root,`executor-${id}.json`);}
  async save(s) {await mkdir(this.root,{recursive:true});const f=this.file(s.id),tmp=f+'.tmp';await writeFile(tmp,JSON.stringify(s,null,2));await rename(tmp,f);}
  async read(id) {return JSON.parse(await readFile(this.file(id),'utf8'));}
  async call(method,r) {
    if(method==='session/create') {
      if(!existsSync(this.exe))throw Error('DeepSeek Harness executable not found; set DSH_DESKTOP_EXE');
      if(!(await stat(r.cwd)).isDirectory())throw Error('cwd must be a directory');
      const s={id:r.sessionId || randomUUID(),cwd:r.cwd,status:'created',runs:[]};await this.save(s);return {sessionId:s.id};
    }
    const id=r.sessionId || r.address?.sessionId;
    const s=this.active.get(id)?.state || await this.read(id);
    if(method==='session/state')return {status:s.status==='running'&&!this.active.has(id)?'interrupted':s.status,dshSessionId:s.dshSessionId,lastRun:s.runs.at(-1),review:'not_reviewed'};
    if(method==='session/events')return {runs:s.runs,hasMore:false};
    if(method==='session/cancel') {
      const run=this.active.get(id);if(!run)return {cancelled:false};
      // A headless root owns its in-process team; terminate only this exact process tree.
      if(process.platform==='win32')spawn('taskkill',['/pid',String(run.child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
      else run.child.kill('SIGTERM');
      return {cancellationRequested:true};
    }
    if(method!=='session/prompt')throw Error('Unsupported headless method');
    if(s.runs.some(x=>x.requestId===r.requestId))return {accepted:true,duplicate:true};
    if(this.active.has(id))throw Error('Executor busy; wait before sending feedback');
    if(s.status==='running')throw Error('Previous bridge stopped while executor was running. Inspect the dsh session before retrying.');
    const run={requestId:r.requestId,startedAt:new Date().toISOString(),events:[]};
    s.runs.push(run);s.status='running';await this.save(s);
    const args=['--expose-internals',this.cli,'headless','--patch',this.patch,'--json'];
    if(s.dshSessionId)args.push('--session-id',s.dshSessionId);
    args.push('-');
    const child=spawn(this.exe,args,{cwd:s.cwd,env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.active.set(id,{child,state:s});
    let buffer='',diagnostics='';
    const line=text=>{try {const e=JSON.parse(text);if(e.type==='session')s.dshSessionId=e.sessionId;if(e.type==='final')run.final=e;if(e.type!=='thinking')run.events.push(e);}catch {diagnostics=(diagnostics+text+'\n').slice(-16000);}};
    child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>{buffer+=chunk;let n;while((n=buffer.indexOf('\n'))>=0){line(buffer.slice(0,n));buffer=buffer.slice(n+1);}});
    child.stderr.setEncoding('utf8');child.stderr.on('data',c=>{diagnostics=(diagnostics+c).slice(-16000);});
    child.on('error',e=>{run.error=e.message;});
    child.stdin.on('error',e=>{run.error=e.message;});
    child.on('close',async code=>{
      if(buffer.trim())line(buffer);
      run.exitCode=code;run.finishedAt=new Date().toISOString();run.diagnostics=diagnostics;
      s.status=code===0&&run.final?.reason?.kind==='completed'?'awaiting_review':'failed';
      try {await this.save(s);}catch(e){process.stderr.write(`Cannot persist executor state: ${e.message}\n`);}finally{this.active.delete(id);}
    });
    child.stdin.end(r.content.filter(p=>p.type==='text').map(p=>p.text).join('\n'));
    return {accepted:true};
  }
  close() {for(const {child} of this.active.values())child.kill();}
}
