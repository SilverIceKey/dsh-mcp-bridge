import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

export class DshClient {
  constructor(url = process.env.DSH_URL, token = process.env.DSH_TOKEN) {
    this.url = url; this.token = token;
  }
  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.pending) return this.pending;
    this.pending = this.open();
    try { await this.pending; } finally { this.pending = null; }
  }
  async open() {
    if (!this.url || !this.token) throw new Error('Set DSH_URL and DSH_TOKEN from the dsh connection URL.');
    const base = new URL(this.url);
    if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('Only local HTTP dsh endpoints are supported.');
    const link = new URL('/connect', base);
    link.searchParams.set('token', this.token);
    link.searchParams.set('interactions', 'none');
    const res = await fetch(link, {redirect:'manual', signal:AbortSignal.timeout(10000)});
    if (res.status !== 302) throw new Error(`dsh authentication failed (HTTP ${res.status})`);
    const cookies = res.headers.getSetCookie();
    this.cookie = cookies.map(v => v.split(';')[0]).join('; ');
    if (!this.cookie) throw new Error('dsh did not issue an API cookie');
    const target = new URL('/api/remote.mux', base); target.protocol = 'ws:';
    const socket = new WebSocket(target, {headers:{Cookie:this.cookie}, handshakeTimeout:10000});
    this.socket = socket;
    await new Promise((resolve,reject) => { socket.once('open',resolve); socket.once('error',reject); });
    socket.on('error', () => {});
  }
  async call(method, request) {
    await this.connect();
    const rpcId = randomUUID();
    const res = await fetch(new URL(`/api/${method}`, this.url), {
      method:'POST', headers:{'Content-Type':'application/json', Cookie:this.cookie},
      body:JSON.stringify({type:'client-request',rpcId,method,payload:{args:{request}}}),
      signal:AbortSignal.timeout(30000)
    });
    if (!res.ok) throw new Error(`dsh request failed (HTTP ${res.status}); no automatic retry was performed.`);
    const data = await res.json();
    if (data.rpcId !== rpcId || data.type !== 'server-response') throw new Error('Invalid dsh response');
    if (!data.result?.ok) throw new Error(`${data.result?.error?.code}: ${data.result?.error?.message}`);
    return data.result.value;
  }
  close() { this.socket?.close(); }
}
