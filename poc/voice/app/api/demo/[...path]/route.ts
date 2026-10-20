import { demoRequestAllowed } from '../../../../lib/demo/security';
import { DemoError } from '../../../../lib/demo/model';
import { authorizedDemo, newDemo } from '../../../../lib/demo/store';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
async function handle(request:Request, context:{params:Promise<{path:string[]}>}) {
 if(!demoRequestAllowed(request,process.env.MIRAI_OFFLINE_DEMO)) return json({error:'Offline demo is disabled or this request is not local'},404);
 try {
  const {path}=await context.params;
  if(request.method==='POST' && path.length===1 && path[0]==='setup') {
   // Explicit developer launch creates both named fixture roles. Never accepts a requested role or identity.
   if((await request.text()).length) throw new DemoError('Setup accepts no fields');
   const response=json({status:'Demo workspace created; two developer fixtures, not production authentication'});
   for(const cookie of newDemo(request)) response.headers.append('Set-Cookie',cookie);
   return response;
  }
  if(path.length!==2 || !['faculty','student'].includes(path[0])) return json({error:'Demo route not found'},404);
  const role=path[0] as 'faculty'|'student';const workspace=authorizedDemo(request,role);
  if(request.method==='POST') {
   if(!request.headers.get('content-type')?.startsWith('application/json')) throw new DemoError('JSON required');
   const raw=await request.text();if(raw.length>8192) throw new DemoError('Request too large',413);
   let data:unknown;try {data=JSON.parse(raw);} catch {throw new DemoError('Malformed JSON');}
   if(!data||typeof data!=='object'||Array.isArray(data)) throw new DemoError('Expected an object');
   workspace.command(role,path[1],data as Record<string,unknown>);
  } else if(path[1]!=='view') return json({error:'Demo route not found'},404);
  return json(role==='faculty'?workspace.facultyView():workspace.studentView());
 } catch(error) {
  return error instanceof DemoError ? json({error:error.code},error.status) : json({error:'Local demo failed safely; refresh and retry'},500);
 }
}
export const GET=handle;
export const POST=handle;
