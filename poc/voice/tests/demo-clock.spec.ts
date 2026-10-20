import {test,expect} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {DemoWorkspace} from '../lib/demo/model';
import {vivaPhase} from '../lib/demo/clock';
function fixture(mode='standard') {
 let now=0;const w=new DemoWorkspace({now:()=>now});
 const send=(role:'student'|'faculty',action:string,data:object)=>w.command(role,action,{request_id:randomUUID(),...data});
 send('faculty','approve',{revision:0});send('student','start',{consent:true,timing_mode:mode});
 return {w,s:w.sessions[0],send,advance:(ms:number)=>{now=ms;}};
}
test('official phase boundaries scale consistently in accelerated mode',()=>{
 const phases=['Warm-up','Fundamentals','Depth','Applied problem','Wrap-up','Scoring','Finished'];
 [0,60,300,600,780,870,900].forEach((n,i)=>{
  expect(vivaPhase(n*1000,900000)).toBe(phases[i]);
  expect(vivaPhase(n/900*120000,120000)).toBe(phases[i]);
 });
});
test('server expires without client activity, evaluates once, rejects late answers and preserves evidence',()=>{
 const {w,s,send,advance}=fixture();
 send('student','answer',{session_id:s.id,revision:s.revision,scenario:'partial'});
 advance(869999);w.tick();expect(s.status).toBe('active');expect(s.clock_phase).toBe('Wrap-up');
 advance(870000);w.tick();expect(s.status).toBe('completed');expect(s.evaluation).not.toBeNull();
 const hash=s.evaluation!.transcript_hash;const id=s.evaluation!.id;const events=w.audit.length;
 advance(900001);w.tick();w.studentView();w.facultyView();
 expect(()=>send('student','answer',{session_id:s.id,revision:s.revision,scenario:'strong'})).toThrow();
 expect(s.turns).toHaveLength(1);expect(s.evaluation!.id).toBe(id);expect(s.evaluation!.transcript_hash).toBe(hash);expect(w.audit).toHaveLength(events);
});
test('mutation checks deadline even when scheduler has not run; accelerated empty report is not a score',()=>{
 const {w,s,send,advance}=fixture('accelerated');advance(116000);
 expect(()=>send('student','answer',{session_id:s.id,revision:0,scenario:'strong'})).toThrow();
 expect(s.status).toBe('completed');expect(s.turns).toHaveLength(0);expect(s.evaluation!.original_total).toBeNull();
 expect(w.audit.filter(e=>e.action==='session_completed')).toHaveLength(1);
});
test('refresh cannot reset clock; rollback cannot extend remaining time; sessions isolated',()=>{
 const a=fixture(),b=fixture();a.advance(60000);a.w.studentView();expect(a.s.remaining_ms).toBe(840000);
 a.advance(0);a.w.tick();expect(a.s.remaining_ms).toBe(840000);expect(b.s.remaining_ms).toBe(900000);
});
