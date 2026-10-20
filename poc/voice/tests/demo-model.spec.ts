import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { DemoWorkspace, DemoError, total, RUBRIC } from '../lib/demo/model';
import { calculateTranscriptHash } from '../lib/evaluation/contract';
import { demoRequestAllowed } from '../lib/demo/security';
const send=(w:DemoWorkspace,role:'faculty'|'student',action:string,data:object={})=>w.command(role,action,{request_id:randomUUID(),...data});
function approved(){const w=new DemoWorkspace();send(w,'faculty','approve',{revision:0});return w;}
function start(w:DemoWorkspace){send(w,'student','start',{consent:true});return w.sessions.at(-1)!;}
function answer(w:DemoWorkspace,scenario:string){const s=w.sessions.at(-1)!;send(w,'student','answer',{session_id:s.id,revision:s.revision,scenario});}
function complete(){const w=approved();const s=start(w);while(s.status==='active')answer(w,'strong');return {w,s};}
function rejected(action:()=>void,code:number){try{action();throw new Error('Expected rejection');}catch(e){expect(e).toBeInstanceOf(DemoError);expect((e as DemoError).status).toBe(code);}}
test('demo rubric uses exact official dimensions, ranges and weighted arithmetic',()=>{
 expect(RUBRIC.map(x=>x[0])).toEqual(['Conceptual understanding','Depth and reasoning','Problem solving','Practical / project knowledge','Communication']);
 expect(total([5,4,3,2,1])).toBe(70);expect(total([0,0,0,0,0])).toBe(0);expect(total([5,5,5,5,5])).toBe(100);expect(total([4,3,4,5,4])).toBe(78);
 expect(total([null,1,2,3,4])).toBeNull();
 for(const v of [-1,6,1.5,NaN,Infinity,'5'])expect(()=>total([v as number,0,0,0,0])).toThrow();expect(()=>total([1,2])).toThrow();
});
test('consent and complete approval eligibility enforced; approved banks immutable',()=>{
 const w=new DemoWorkspace();rejected(()=>start(w),409);send(w,'faculty','approve',{revision:0});
 rejected(()=>send(w,'student','start',{consent:false}),400);rejected(()=>send(w,'faculty','question',{revision:1}),409);
 const broken=new DemoWorkspace();broken.bank.questions.pop();rejected(()=>send(broken,'faculty','approve',{revision:0}),400);
 const invalid=new DemoWorkspace();invalid.bank.questions[0].accepted_concepts=[];rejected(()=>send(invalid,'faculty','approve',{revision:0}),400);
});
test('draft creation validates metadata, retains provenance and rejects stale saves',()=>{
 const w=new DemoWorkspace();const data={revision:0,question_id:null,prompt:'How would you recover from a failed database write?',topic:'API reliability',difficulty:3,accepted_concepts:['transaction','retry']};
 rejected(()=>send(w,'faculty','question',{...data,difficulty:8}),400);rejected(()=>send(w,'faculty','question',{...data,prompt:'x'}),400);
 send(w,'faculty','question',data);expect(w.bank.questions).toHaveLength(6);expect(w.bank.questions[5].branch).toBe('next');
 rejected(()=>send(w,'faculty','question',data),409);
});
test('student cannot approve, override or read faculty scores; forged fields rejected',()=>{
 const w=approved();rejected(()=>send(w,'student','approve',{revision:1}),403);rejected(()=>send(w,'student','override',{}),403);
 rejected(()=>send(w,'faculty','start',{consent:true}),403);rejected(()=>send(w,'student','start',{consent:true,score:5}),400);
 const s=start(w);answer(w,'partial');send(w,'student','end',{session_id:s.id,revision:s.revision});
 expect(w.studentView().session).not.toHaveProperty('evaluation');expect(w.facultyView().sessions[0].evaluation).not.toBeNull();
});
test('duplicate commands are idempotent; conflicting requests and stale turns cannot corrupt state',()=>{
 const w=approved();const request={request_id:randomUUID(),consent:true};w.command('student','start',request);w.command('student','start',request);expect(w.sessions).toHaveLength(1);
 rejected(()=>w.command('student','start',{...request,consent:false}),409);rejected(()=>start(w),409);
 const s=w.sessions[0];const turn={request_id:randomUUID(),session_id:s.id,revision:0,scenario:'partial'};
 w.command('student','answer',turn);w.command('student','answer',turn);expect(s.turns).toHaveLength(1);
 rejected(()=>send(w,'student','answer',{...turn,request_id:randomUUID()}),409);
});
test('adaptive rules map all scenarios; repeated nudge moves on; only approved IDs selected',()=>{
 for(const [scenario,branch] of [['strong','deeper'],['partial','partial'],['none','next'],['off_topic','redirect']]){
  const w=approved();const s=start(w);answer(w,scenario);
  expect(s.turns[0].classification).toBe(branch);expect(w.bank.questions.find(q=>q.id===s.current_question_id)?.branch).toBe(branch);
  expect(s.asked.every(id=>w.bank.questions.some(q=>q.id===id))).toBe(true);
 }
 const w=approved();start(w);answer(w,'partial');answer(w,'partial');expect(w.studentView().question?.phase).toBe('applied');
});
test('session completion is bounded, evidence is local and structured, no extra turns accepted',()=>{
 const {w,s}=complete();expect(s.turns.length).toBeLessThanOrEqual(5);expect(s.status).toBe('completed');
 expect(s.evaluation?.original_total).toBe(70);expect(s.evaluation?.scores).toHaveLength(5);
 for(const c of s.evaluation!.scores)for(const id of c.evidence_turn_ids)expect(s.turns.some(t=>t.id===id&&t.session_id===s.id)).toBe(true);
 expect(s.turns.map(t=>t.start_ms)).toEqual(s.turns.map((_,i)=>i*30000));expect(s.bank_id).toBe(w.bank.id);
 const hash=s.evaluation!.transcript_hash;rejected(()=>answer(w,'strong'),409);expect(s.evaluation!.transcript_hash).toBe(hash);
});
test('a path covering all five branch questions ends exactly at the fifth answer',()=>{
 const w=approved();const s=start(w);
 for(const scenario of ['strong','partial','off_topic','none','strong'])answer(w,scenario);
 expect(s.turns).toHaveLength(5);expect(s.status).toBe('completed');expect(new Set(s.asked).size).toBe(5);
 rejected(()=>answer(w,'strong'),409);
 expect(s.evaluation!.feedback[1].text).toContain(s.turns[1].decision);
});
test('overrides append history, preserve original and hash, validate score reason and criterion ownership',()=>{
 const {w,s}=complete();const e=s.evaluation!;const c=e.scores[0];const before=e.transcript_hash;
 const data={session_id:s.id,revision:s.revision,criterion_score_id:c.id,new_score:4,reason:'The cited response supports this demonstration override.'};
 for(const new_score of [-1,6,1.2,'5'])rejected(()=>send(w,'faculty','override',{...data,new_score}),400);
 rejected(()=>send(w,'faculty','override',{...data,reason:'   '}),400);rejected(()=>send(w,'faculty','override',{...data,criterion_score_id:randomUUID()}),400);
 send(w,'faculty','override',data);expect(e.original_total).toBe(70);expect(e.final_total).toBe(64);expect(c.score).toBe(5);
 send(w,'faculty','override',{...data,revision:s.revision,new_score:3});expect(e.overrides.map(o=>[o.old_score,o.new_score])).toEqual([[5,4],[4,3]]);
 expect(e.final_total).toBe(58);expect(e.transcript_hash).toBe(before);expect(w.audit.filter(e=>e.action==='score_overridden')).toHaveLength(2);
});
test('empty interviews have no invented scores or evidence and cannot be overridden',()=>{
 const w=approved();const s=start(w);send(w,'student','end',{session_id:s.id,revision:0});
 expect(s.evaluation?.original_total).toBeNull();expect(s.evaluation?.scores.every(c=>c.score===null&&!c.evidence_turn_ids.length)).toBe(true);
 rejected(()=>send(w,'faculty','override',{session_id:s.id,revision:s.revision,criterion_score_id:s.evaluation!.scores[0].id,new_score:4,reason:'No response to support this mark'}),400);
});
test('workspaces and repeat sessions are isolated; malformed and foreign IDs fail safely',()=>{
 const w=approved();const other=approved();const s=start(w);const foreign=start(other);
 rejected(()=>send(w,'student','end',{session_id:'bad',revision:0}),400);
 rejected(()=>send(w,'student','end',{session_id:foreign.id,revision:0}),404);
 send(w,'student','end',{session_id:s.id,revision:0});const second=start(w);expect(second.id).not.toBe(s.id);expect(second.turns).toEqual([]);expect(foreign.status).toBe('active');
});
test('demo gate defaults closed and rejects remote hosts, origins and role-independent spoofing',()=>{
 const request=(headers:Record<string,string>={})=>new Request('http://127.0.0.1:3000/api/demo/setup',{method:'POST',headers:{host:'127.0.0.1:3000',origin:'http://127.0.0.1:3000',...headers}});
 expect(demoRequestAllowed(request(),undefined)).toBe(false);expect(demoRequestAllowed(request(),'0')).toBe(false);expect(demoRequestAllowed(request(),'1')).toBe(true);
 const invalid: Record<string,string>[]=[{host:'0.0.0.0:3000'},{origin:'https://evil.example'},{forwarded:'host=localhost'},{'x-forwarded-host':'evil.example'},{'sec-fetch-site':'cross-site'}];
 for(const headers of invalid)expect(demoRequestAllowed(request(headers),'1')).toBe(false);
});
test('session finalization generates canonical transcript, SHA-256 hash, and evaluation record', () => {
 const { w, s } = complete();
 expect(s.finalized_transcript).toBeDefined();
 expect(s.finalized_transcript!.status).toBe('completed');
 expect(s.finalized_transcript!.session_id).toBe(s.id);
 expect(s.finalized_transcript!.student_id).toBe(w.student);
 expect(s.finalized_transcript!.bank_id).toBe(w.bank.id);
 expect(s.finalized_transcript!.turns).toHaveLength(s.turns.length);
 const expectedHash = calculateTranscriptHash(s.finalized_transcript!.turns);
 expect(s.finalized_transcript!.transcript_hash).toBe(expectedHash);
 expect(s.evaluation!.transcript_hash).toBe(expectedHash);

 expect(s.evaluation_record).toBeDefined();
 expect(s.evaluation_record!.transcript_hash).toBe(expectedHash);
 expect(s.evaluation_record!.ai_total).toBe(70);
 expect(s.evaluation_record!.final_total).toBe(70);
 expect(s.evaluation_record!.provenance.is_synthetic).toBe(true);

 for (const sc of s.evaluation_record!.scores) {
   for (const ev of sc.evidence) {
     const turn = s.turns.find(t => t.id === ev.turn_id);
     expect(turn).toBeDefined();
     expect(turn!.response).toContain(ev.quote);
   }
 }
});
test('faculty override updates both evaluation and evaluation_record with immutable originals', () => {
 const { w, s } = complete();
 const e = s.evaluation!;
 const criterion = e.scores[0];
 const recordOriginalScore = s.evaluation_record!.scores[0].score;
 const data = { session_id: s.id, revision: s.revision, criterion_score_id: criterion.id, new_score: 4, reason: 'Valid faculty override reason' };
 send(w, 'faculty', 'override', data);

 expect(e.original_total).toBe(70);
 expect(e.final_total).toBe(64);
 expect(criterion.score).toBe(5);
 expect(criterion.final_score).toBe(4);

 expect(s.evaluation_record!.ai_total).toBe(70);
 expect(s.evaluation_record!.final_total).toBe(64);
 expect(s.evaluation_record!.scores[0].score).toBe(recordOriginalScore);
 expect(s.evaluation_record!.scores[0].effective_score).toBe(4);
 expect(s.evaluation_record!.overrides).toHaveLength(1);
 expect(s.evaluation_record!.overrides[0].old_score).toBe(5);
 expect(s.evaluation_record!.overrides[0].new_score).toBe(4);
 expect(s.evaluation_record!.overrides[0].reason).toBe('Valid faculty override reason');
});
test('student view strictly strips evaluation, evaluation_record, and finalized_transcript', () => {
 const { w } = complete();
 const sv = w.studentView();
 expect(sv.session).toBeDefined();
 expect(sv.session).not.toHaveProperty('evaluation');
 expect(sv.session).not.toHaveProperty('evaluation_record');
 expect(sv.session).not.toHaveProperty('finalized_transcript');
});
test('evaluation failure handles errors atomically, leaving explicit review_required state rather than null evaluation', () => {
 const w = approved();
 const s = start(w);
 answer(w, 'strong');
 s.turns[0] = { ...s.turns[0], response: '' };
 send(w, 'student', 'end', { session_id: s.id, revision: s.revision });

 expect(s.status).toBe('completed');
 expect(s.finalized_transcript).toBeDefined();
 expect(s.evaluation).toBeDefined();
 expect(s.evaluation!.status).toBe('review_required');
 expect(s.evaluation!.original_total).toBeNull();
 expect(s.evaluation!.final_total).toBeNull();
 expect(s.evaluation!.review_reasons.some(r => r.includes('Evaluation failure'))).toBe(true);
 expect(w.audit.some(a => a.action === 'evaluation_failed')).toBe(true);
});
