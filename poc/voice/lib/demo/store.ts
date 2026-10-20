import 'server-only';
import { randomBytes } from 'node:crypto';
import { DemoError, DemoWorkspace } from './model';
type Role='faculty'|'student';
type Entry={workspace:DemoWorkspace; role:Role; expires:number};
type Store={tokens:Map<string,Entry>;workspaces:Map<string,DemoWorkspace>; timer?:ReturnType<typeof setInterval>};
const shared=globalThis as typeof globalThis & {miraiOfflineDemoStore?:Store};
const store:Store=shared.miraiOfflineDemoStore??={tokens:new Map(),workspaces:new Map()};
function prune() {
 const now=Date.now();
 for(const [id,w] of store.workspaces) if(now-w.created_at>=3600000) store.workspaces.delete(id);
 for(const [token,e] of store.tokens) if(e.expires<=now||!store.workspaces.has(e.workspace.id)) store.tokens.delete(token);
}
export function newDemo() {
 prune();if(store.workspaces.size>=40) throw new DemoError('Demo workspace capacity reached; restart the local server',409);
 const workspace=new DemoWorkspace();store.workspaces.set(workspace.id,workspace);
 const cookies=(['faculty','student'] as const).map(role=>{
  const token=randomBytes(32).toString('hex');store.tokens.set(token,{workspace,role,expires:Date.now()+3600000});
  return `mirai_demo_${role}=${token}; HttpOnly; SameSite=Strict; Path=/api/demo/${role}; Max-Age=3600`;
 });
 return cookies;
}
export function authorizedDemo(request:Request, role:Role) {
 prune();const prefix=`mirai_demo_${role}=`;
 const token=request.headers.get('cookie')?.split(';').map(v=>v.trim()).find(v=>v.startsWith(prefix))?.slice(prefix.length);
 const entry=token ? store.tokens.get(token) : null;
 if(!entry || entry.role!==role) throw new DemoError('Demo fixture access expired or unavailable. Create a local workspace.',403);
 return entry.workspace;
}

// Local process only: closes sessions even when the browser is suspended/disconnected.
// One unref'ed scheduler survives hot reload through the existing global store.
if (!store.timer) {
 store.timer=setInterval(()=>{prune();for(const w of store.workspaces.values()) w.tick();},250);
 store.timer.unref();
}
