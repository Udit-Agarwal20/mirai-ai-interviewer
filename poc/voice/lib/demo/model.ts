/** Ephemeral synthetic adapter. No provider imports, database, files, or network. */
import { vivaPhase, type DemoClock } from './clock';
import { randomUUID } from 'node:crypto';
import type { Audit, Bank, Branch, DemoSession, Evaluation, FacultyView, Question, Scenario, StudentView } from './types';
import { finalizeSessionTranscript } from '../evaluation/finalizer';
import { EvaluationService, SyntheticMockEvaluatorAdapter } from '../evaluation/evaluator';
import { CRITERION_CODES, getCriterionDefinition } from '../evaluation/contract';
export class DemoError extends Error { constructor(public code: string, public status = 400) { super(code); } }
function fail(code: string, status = 400): never { throw new DemoError(code,status); }
export const uuid = (value: unknown): string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : fail('Invalid identifier');
const text = (v: unknown, min: number, max: number): string => typeof v === 'string' && v.trim().length >= min && v.trim().length <= max ? v.trim() : fail(`Text must contain ${min}–${max} characters`);
export const score = (v: unknown): number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 5 ? v : fail('Score must be an integer from 0 to 5');
export const RUBRIC = [
  ['Conceptual understanding',30], ['Depth and reasoning',25], ['Problem solving',20],
  ['Practical / project knowledge',15], ['Communication',10]
] as const;
export function total(scores: (number | null)[]) {
  if(scores.length !== 5) fail('Exactly five dimensions required');
  scores.forEach(v=>{if(v!==null) score(v);});
  if(scores.some(v=>v===null)) return null;
  // Each integer score contributes an integer: weights / 5 = 6,5,4,3,2. No rounding loss.
  return scores.reduce<number>((sum,v,i)=>sum+v!*(RUBRIC[i][1]/5),0);
}
const evaluationService = new EvaluationService();
const mockAdapter = new SyntheticMockEvaluatorAdapter();
const CLASS: Record<Scenario,Exclude<Branch,'opening'>> = {strong:'deeper',partial:'partial',none:'next',off_topic:'redirect'};
const LABELS: Record<Scenario,string> = {strong:'Strong answer',partial:'Partially correct answer',none:'No answer',off_topic:'Off-topic answer'};
const PRESET: Record<Scenario,number[]> = {strong:[5,4,3,2,1],partial:[3,2,2,1,3],none:[0,0,0,0,0],off_topic:[0,0,0,0,1]};
const seed: [Branch,Question['phase'],string,string[]][] = [
 ['opening','fundamentals','What does idempotency mean for an HTTP API?',['repeat requests','same intended effect']],
 ['deeper','depth','How would you handle two simultaneous requests using the same idempotency key?',['atomic claim','unique key','stored result']],
 ['partial','fundamentals','Consider a client repeating a request after a timeout. What property should remain unchanged?',['same intended effect']],
 ['next','applied','How would you test whether an API handles duplicate requests safely?',['concurrent requests','single effect','failure recovery']],
 ['redirect','fundamentals','Please focus on the API question. What happens if the client repeats the request?',['repeat requests','same intended effect']]
];
function response(q: Question, s: Scenario) {
 if(s==='none') return "I don't know yet.";
 if(s==='off_topic') return 'Can we talk about lunch instead of the API question?';
 if(s==='partial') return 'Repeating a request should usually be safe, but I am unsure how to handle failures and concurrent requests.';
 if(q.branch==='deeper') return 'I would atomically claim a unique key, bind it to the request payload, and store the result so concurrent retries cannot apply the effect twice.';
 if(q.phase==='applied') return 'I would send concurrent requests with the same key, simulate a timeout after the write, then assert one effect and consistent results. I would also test conflicting payloads.';
 return 'Idempotency means repeating an operation has the same intended effect as performing it once. A retry must not create a second payment; its response may still differ.';
}
export class DemoWorkspace {
 readonly id = randomUUID(); readonly subject = 'Backend engineering · HTTP API reliability';
 readonly faculty = 'faculty-developer-fixture'; readonly student = 'student-developer-fixture';
 readonly created_at = Date.now();
 bank: Bank = {id:randomUUID(),version:1,revision:0,status:'draft',approved_by:null,approved_at:null,
   questions:seed.map(([branch,phase,prompt,concepts],i)=>({id:randomUUID(),external_ref:`DEMO-HTTP-${i+1}`,topic:'HTTP idempotency',difficulty:phase==='depth'?4:2,phase,prompt,accepted_concepts:concepts,origin:'faculty_generated',branch}))};
 sessions: DemoSession[] = []; audit: Audit[] = [];
 constructor(private clock: DemoClock = {now: () => performance.now()}) {}
 private deadlines = new Map<string, number>();
 /** Called by the server scheduler, reads, and every mutation; browser clocks have no authority. */
 tick() {
  for (const s of this.sessions) {
   const deadline = this.deadlines.get(s.id);
   if (deadline === undefined || s.status !== 'active') continue;
   s.remaining_ms = Math.max(0, Math.min(s.remaining_ms, deadline - this.clock.now()));
   s.clock_phase = vivaPhase(s.duration_ms - s.remaining_ms, s.duration_ms);
   // Official interview closes at 14:30; the remaining 30s is reserved for scoring.
   if (s.remaining_ms <= s.duration_ms / 30) {
    this.finish(s, 'Interview deadline reached; reserved scoring window');
    s.revision++;
    this.deadlines.delete(s.id);
   }
  }
 }
 private commands = new Map<string,string>();
 private event(actor: string, action: string, resource: string, detail: string) {
  this.audit.push({id:randomUUID(),actor_id:actor,action,resource_id:resource,at:new Date().toISOString(),detail});
 }
 facultyView(): FacultyView { this.tick(); return structuredClone({workspace_id:this.id,subject:this.subject,bank:this.bank,sessions:this.sessions,audit:this.audit}); }
 studentView(): StudentView {
  this.tick();
  const session=this.sessions.at(-1) ?? null;
  const q=this.bank.questions.find(q=>q.id===session?.current_question_id);
  const {evaluation: _privateEvaluation, evaluation_record: _privateRecord, finalized_transcript: _privateTranscript, ...safe}=session ?? {evaluation:null, evaluation_record:null, finalized_transcript:null};
  return structuredClone({subject:this.subject,bank_status:this.bank.status,bank_version:this.bank.version,
    session:session ? safe as Omit<DemoSession,'evaluation'|'evaluation_record'|'finalized_transcript'> : null,
    question:q ? {id:q.id,prompt:q.prompt,phase:q.phase} : null,
    responses:q ? (Object.keys(CLASS) as Scenario[]).map(id=>({id,label:LABELS[id],text:response(q,id)})) : []});
 }
 /** Synchronous command application makes revision checks + mutations atomic in this one process. */
 command(role: 'faculty'|'student', action: string, input: Record<string,unknown>) {
  this.tick();
  const allowed = role==='faculty' ? ['question','approve','override'] : ['start','answer','end'];
  if(!allowed.includes(action)) fail('Role does not permit this action',403);
  const keys: Record<string,string[]> = {question:['request_id','revision','question_id','prompt','topic','difficulty','accepted_concepts'],approve:['request_id','revision'],start:['request_id','consent','timing_mode'],answer:['request_id','session_id','revision','scenario'],end:['request_id','session_id','revision'],override:['request_id','session_id','revision','criterion_score_id','new_score','reason']};
  if(Object.keys(input).some(k=>!keys[action].includes(k))) fail('Unexpected request field');
  const id=uuid(input.request_id); const signature=JSON.stringify([role,action,input]);
  if(this.commands.has(id)) { if(this.commands.get(id)!==signature) fail('Request identifier reused with different data',409); return; }
  if(this.commands.size>=300) fail('Demo workspace limit reached; start a new workspace',409);
  if(action==='question' || action==='approve') {
   if(this.bank.status!=='draft') fail('Approved bank versions are immutable',409);
   if(input.revision!==this.bank.revision) fail('Bank changed; refresh before saving',409);
   if(action==='question') {
    const prompt=text(input.prompt,10,500);const topic=text(input.topic,2,80);
    if(!Number.isInteger(input.difficulty)||Number(input.difficulty)<1||Number(input.difficulty)>5) fail('Difficulty must be 1–5');
    if(!Array.isArray(input.accepted_concepts)||input.accepted_concepts.length<1||input.accepted_concepts.length>8) fail('Supply 1–8 accepted concepts');
    const concepts=input.accepted_concepts.map(v=>text(v,2,100));
    let q: Question;
    if(input.question_id===null) {
     if(this.bank.questions.length>=12) fail('Demo bank limit reached');
     q={id:randomUUID(),external_ref:`DEMO-HTTP-${this.bank.questions.length+1}`,topic,difficulty:Number(input.difficulty),phase:'applied',prompt,accepted_concepts:concepts,origin:'faculty_generated',branch:'next'};
     this.bank.questions.push(q);
    } else {
     const existing=this.bank.questions.find(q=>q.id===uuid(input.question_id));
     if(!existing) fail('Question not found',404);
     q=existing!; Object.assign(q,{prompt,topic,difficulty:input.difficulty,accepted_concepts:concepts});
    }
    this.event(this.faculty,'question_saved',q.id,'Draft question saved by developer faculty fixture');
   } else {
    if(seed.some(([branch])=>!this.bank.questions.some(q=>q.branch===branch)) || this.bank.questions.some(q=>!q.prompt.trim()||!q.topic.trim()||!q.accepted_concepts.length||q.difficulty<1||q.difficulty>5)) fail('Bank needs all five branches and valid question metadata');
    this.bank.status='approved';this.bank.approved_by=this.faculty;this.bank.approved_at=new Date().toISOString();
    this.event(this.faculty,'bank_approved',this.bank.id,'Immutable demo bank v1 approved; all branch targets reviewed');
   }
   this.bank.revision++;
  } else if(action==='start') {
   if(input.timing_mode!==undefined && !['accelerated','standard'].includes(String(input.timing_mode))) fail('Invalid timing mode');
   if(input.consent!==true) fail('Explicit offline simulation consent required');
   if(this.bank.status!=='approved') fail('Faculty must approve the question bank first',409);
   if(this.sessions.some(s=>s.status==='active')) fail('An interview is already active',409);
   if(this.sessions.length>=12) fail('Demo session limit reached');
   const q=this.bank.questions.find(q=>q.branch==='opening')!;const at=new Date().toISOString();
   const s:DemoSession={id:randomUUID(),revision:0,student_id:this.student,status:'active',bank_id:this.bank.id,bank_version:this.bank.version,
    duration_ms:input.timing_mode==='standard'?900000:120000, remaining_ms:input.timing_mode==='standard'?900000:120000, clock_phase:'Warm-up', timing_mode:input.timing_mode==='standard'?'standard':'accelerated',
    consent:{accepted:true,version:'offline-demo-consent-v1',at},started_at:at,ended_at:null,end_reason:null,
    current_question_id:q.id,asked:[q.id],used_branches:['opening'],turns:[],evaluation:null};
   this.deadlines.set(s.id,this.clock.now()+s.duration_ms);
   this.sessions.push(s);this.event(this.student,'session_started',s.id,'Explicit simulation consent; no microphone or audio');
  } else {
   const sessionId=uuid(input.session_id);const s=this.sessions.find(s=>s.id===sessionId);
   if(!s) fail('Session not found in this workspace',404);
   if(input.revision!==s!.revision) fail('Session changed; refresh before submitting',409);
   if(action==='override') {
    if(s!.status!=='completed'||!s!.evaluation) fail('Complete interview before review',409);
    const e=s!.evaluation!;const criterionId=uuid(input.criterion_score_id); const c=e.scores.find(c=>c.id===criterionId);
    if(!c || c.final_score===null) fail('No scored criterion to override');
    const value=score(input.new_score);const reason=text(input.reason,10,3000);
    const change={id:randomUUID(),criterion_score_id:c!.id,old_score:c!.final_score!,new_score:value,reason,reviewer_id:this.faculty,created_at:new Date().toISOString()};
    e.overrides.push(change);c!.final_score=value;e.final_total=total(e.scores.map(c=>c.final_score));
    if(s!.evaluation_record) {
     const idx=e.scores.findIndex(sc=>sc.id===c!.id);
     if(idx!==-1 && idx<CRITERION_CODES.length) {
      s!.evaluation_record=evaluationService.applyOverride(s!.evaluation_record,{criterion_code:CRITERION_CODES[idx],new_score:value,reason,reviewer_id:this.faculty});
     }
    }
    this.event(this.faculty,'score_overridden',s!.id,`${c!.label}: ${change.old_score} → ${value}. ${reason}`);
   } else {
    if(s!.status!=='active') fail('Completed interviews cannot accept more turns',409);
    if(action==='end') this.finish(s!,'Ended by student');
    else {
     if(typeof input.scenario!=='string'||!Object.hasOwn(CLASS,input.scenario)) fail('Choose a supported response scenario');
     const scenario=input.scenario as Scenario;const q=this.bank.questions.find(q=>q.id===s!.current_question_id)!;
     const classification=CLASS[scenario]; const branch: Branch=s!.used_branches.includes(classification)?'next':classification;
     let next=this.bank.questions.find(q=>q.branch===branch&&!s!.asked.includes(q.id));
     if(!next) next=this.bank.questions.find(q=>q.branch==='next'&&!s!.asked.includes(q.id));
     const ordinal=s!.turns.length+1;if(ordinal>=5) next=undefined;
     const decision=next ? `${classification} → ${next.branch}${branch!==classification?' (branch already used; move on)':''}` : 'Close: turn limit or approved branch pool exhausted';
     s!.turns.push({id:randomUUID(),session_id:s!.id,ordinal,question_id:q.id,question:q.prompt,phase:q.phase,
      response:response(q,scenario),scenario,classification,decision,next_question_id:next?.id??null,start_ms:(ordinal-1)*30000,end_ms:ordinal*30000,committed_at:new Date().toISOString()});
     this.event(this.student,'answer_committed',s!.id,`Turn ${ordinal}; ${decision}`);
     if(next) { s!.current_question_id=next.id;s!.asked.push(next.id);s!.used_branches.push(next.branch); }
     else this.finish(s!,'Approved demo path completed');
    }
   }
   s!.revision++;
  }
  this.commands.set(id,signature);
 }
 private finish(s: DemoSession, reason: string) {
  if (s.status === 'completed' && s.finalized_transcript) return;
  this.deadlines.delete(s.id);
  const finalized = finalizeSessionTranscript(s, reason);

  if (!s.turns.length) {
   const scores = RUBRIC.map(([label, weight]) => ({
    id: randomUUID(),
    label,
    weight,
    score: null,
    final_score: null,
    rationale: 'Insufficient evidence: no response submitted.',
    evidence_turn_ids: []
   }));
   const e: Evaluation = {
    id: randomUUID(),
    status: 'review_required',
    fixture_version: 'offline-score-fixtures-v1',
    transcript_hash: finalized.transcript_hash,
    scores,
    original_total: null,
    final_total: null,
    feedback: [],
    review_reasons: [
      'Interview ended without student responses: insufficient evidence to evaluate',
      'Fixture-derived scores, not AI evaluation',
      'Audio recording unavailable'
    ],
    overrides: [],
    provenance: mockAdapter.provenance
   };
   s.evaluation = e;
   s.evaluation_record = null;
   this.event(this.student, 'session_completed', s.id, reason);
   this.event('offline-fixture-scorer', 'fixture_report_created', s.id, e.fixture_version);
   return;
  }

  try {
   const record = evaluationService.evaluateSessionSync(finalized, mockAdapter);
   s.evaluation_record = record;

   const scores = record.scores.map(sc => {
    const def = getCriterionDefinition(sc.criterion_code);
    return {
     id: randomUUID(),
     label: def.label,
     weight: def.weightPercent,
     score: sc.score,
     final_score: sc.effective_score,
     rationale: sc.rationale,
     evidence_turn_ids: sc.evidence.map(ev => ev.turn_id)
    };
   });

   const e: Evaluation = {
    id: record.id,
    status: record.status === 'complete' ? 'complete' : 'review_required',
    fixture_version: 'offline-score-fixtures-v1',
    transcript_hash: record.transcript_hash,
    scores,
    original_total: record.ai_total,
    final_total: record.final_total,
    feedback: s.turns.slice(0, 3).map(t => ({
     text: `Turn ${t.ordinal}: selected ${LABELS[t.scenario]} (classification: ${t.classification}). Decision: ${t.decision}. This describes the script, not assessed ability.`,
     evidence_turn_ids: [t.id]
    })),
    review_reasons: [...record.review_reasons],
    overrides: [],
    provenance: record.provenance
   };

   s.evaluation = e;
   this.event(this.student, 'session_completed', s.id, reason);
   this.event('offline-fixture-scorer', 'fixture_report_created', s.id, e.fixture_version);
  } catch (error) {
   const errMessage = error instanceof Error ? error.message : 'Evaluation failed';
   const scores = RUBRIC.map(([label, weight]) => ({
    id: randomUUID(),
    label,
    weight,
    score: null,
    final_score: null,
    rationale: `Evaluation error: ${errMessage}. Requires manual faculty review.`,
    evidence_turn_ids: []
   }));
   const e: Evaluation = {
    id: randomUUID(),
    status: 'review_required',
    fixture_version: 'offline-score-fixtures-v1',
    transcript_hash: finalized.transcript_hash,
    scores,
    original_total: null,
    final_total: null,
    feedback: [{ text: `Evaluation engine reported an error: ${errMessage}. No automated score assigned.`, evidence_turn_ids: [] }],
    review_reasons: [
     `Evaluation failure: ${errMessage}`,
     'Manual faculty review required'
    ],
    overrides: [],
    provenance: mockAdapter.provenance
   };
   s.evaluation = e;
   s.evaluation_record = null;
   this.event(this.student, 'session_completed', s.id, reason);
   this.event('offline-evaluation-service', 'evaluation_failed', s.id, errMessage);
  }
 }
}
