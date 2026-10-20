import { test, expect, type APIRequestContext } from '@playwright/test';
import { randomUUID } from 'node:crypto';
const origin='http://127.0.0.1:3000';const headers={Origin:origin,'X-Mirai-Demo':'1'};
const post=(r:APIRequestContext,path:string,data:object)=>r.post('/api/demo/'+path,{headers,data:{request_id:randomUUID(),...data}});
test('complete offline faculty → student → evidence → override workflow has no external requests or microphone',async({page,context})=>{
 const external:string[]=[];
 await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){external.push('external request');return route.abort();}return route.continue();});
 await page.addInitScript(()=>{Object.assign(window,{demoMicCalls:0});Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{(window as unknown as {demoMicCalls:number}).demoMicCalls++;throw new Error('Demo must not use microphone');}});});
 await page.goto('/demo');await page.getByRole('button',{name:'Create local demo workspace',exact:true}).click();
 await page.getByRole('button',{name:'02 Student interview'}).click();await page.getByRole('checkbox').check();
 await expect(page.getByRole('button',{name:'Start Interview',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'01 Question bank'}).click();
 await page.getByRole('button',{name:'Add applied question'}).click();
 await page.getByLabel('Question prompt').fill('How would you test an idempotent payment endpoint after a network failure?');
 await page.getByLabel('Accepted concepts').fill('single payment, retry, stored response');
 await page.getByRole('button',{name:'Save draft question'}).click();await expect(page.getByText('Draft saved. Review before approval.')).toBeVisible();
 await page.getByRole('button',{name:'Approve bank v1'}).click();await page.getByRole('button',{name:'Continue to student'}).click();
 await page.getByRole('button',{name:'Start Interview',exact:true}).click();
 await page.getByRole('button',{name:'Strong answer',exact:false}).click();
 await expect(page.getByRole('heading',{name:'How would you handle two simultaneous requests using the same idempotency key?'}).first()).toBeVisible();
 await page.getByRole('button',{name:'Partially correct answer',exact:false}).click();
 await page.getByRole('button',{name:'No answer',exact:false}).click();
 await page.getByRole('button',{name:'Strong answer',exact:false}).click();
 await page.getByRole('button',{name:'End Interview',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Interview complete',exact:true})).toBeVisible();
 await expect(page.getByText('Score release to students remains gated.',{exact:false})).toBeVisible();
 await page.getByRole('button',{name:'Open faculty fixture review'}).click();
 await expect(page.getByText('Audio recording: Not available in offline demo',{exact:true})).toBeVisible();
 const original=await page.getByTestId('original-total').innerText();
 await page.getByRole('link',{name:'Turn 1',exact:true}).first().click();await expect(page.locator('.demo-turn:target')).toContainText('Idempotency means');
 await page.getByLabel('New score (0–5)').fill('4');await page.getByLabel('Override reason').fill('Faculty fixture reviewed the cited conceptual response.');
 await page.getByRole('button',{name:'Save override',exact:true}).click();
 await expect(page.getByText('Override saved. Original fixture score preserved.')).toBeVisible();
 await expect(page.getByTestId('original-total')).toHaveText(original);await expect(page.getByTestId('final-total')).not.toHaveText(original);
 await expect(page.getByRole('heading',{name:'Override history'})).toBeVisible();
 await page.reload();await page.getByRole('button',{name:'03 Faculty review'}).click();await expect(page.getByRole('heading',{name:'Override history'})).toBeVisible();
 expect(await page.evaluate(()=>(window as unknown as {demoMicCalls:number}).demoMicCalls)).toBe(0);expect(external).toEqual([]);
});
test('demo HTTP role scopes, immutable approval, duplicate start and closed sessions enforced',async({request})=>{
 expect((await request.post('/api/demo/setup')).status()).toBe(404);
 expect((await request.post('/api/demo/setup',{headers})).ok()).toBe(true);
 let f=await (await request.get('/api/demo/faculty/view',{headers})).json();
 expect((await post(request,'student/approve',{revision:0})).status()).toBe(403);
 expect((await post(request,'student/start',{consent:true})).status()).toBe(409);
 expect((await post(request,'faculty/approve',{revision:0})).ok()).toBe(true);
 expect((await post(request,'student/start',{consent:false})).status()).toBe(400);
 const body={request_id:randomUUID(),consent:true};
 const one=await request.post('/api/demo/student/start',{headers,data:body});expect(one.ok()).toBe(true);const s=(await one.json()).session;
 expect((await request.post('/api/demo/student/start',{headers,data:body})).ok()).toBe(true);
 expect((await post(request,'student/start',{consent:true})).status()).toBe(409);
 expect((await post(request,'student/answer',{session_id:s.id,revision:0,scenario:'strong',score:5})).status()).toBe(400);
 expect((await post(request,'student/answer',{session_id:s.id,revision:0,scenario:'strong'})).ok()).toBe(true);
 expect((await post(request,'student/end',{session_id:s.id,revision:1})).ok()).toBe(true);
 expect((await post(request,'student/answer',{session_id:s.id,revision:2,scenario:'strong'})).status()).toBe(409);
 f=await (await request.get('/api/demo/faculty/view',{headers})).json();const report=f.sessions[0];const criterion=report.evaluation.scores[0].id;
 const data={session_id:s.id,revision:2,criterion_score_id:criterion,new_score:4,reason:'A sufficient demo review reason'};
 expect((await post(request,'student/override',data)).status()).toBe(403);
 expect((await post(request,'faculty/override',{...data,new_score:6})).status()).toBe(400);
 expect((await post(request,'faculty/override',{...data,reason:' '})).status()).toBe(400);
 expect((await request.get('/api/demo/student/view',{headers})).ok()).toBe(true);
 expect((await (await request.get('/api/demo/student/view',{headers})).json()).session).not.toHaveProperty('evaluation');
});
test('cross-workspace and student-token impersonation rejected at HTTP boundary',async({playwright})=>{
 const a=await playwright.request.newContext({baseURL:origin});const b=await playwright.request.newContext({baseURL:origin});
 try {
  await a.post('/api/demo/setup',{headers});await b.post('/api/demo/setup',{headers});
  const state=await a.storageState();const studentToken=state.cookies.find(c=>c.name==='mirai_demo_student')!.value;
  // Synthetic opaque fixture token stays inside the test; never logged or persisted.
  const attacker=await playwright.request.newContext({baseURL:origin});
  try {expect((await attacker.get('/api/demo/faculty/view',{headers:{...headers,Cookie:`mirai_demo_faculty=${studentToken}`}})).status()).toBe(403);}finally{await attacker.dispose();}
  await post(a,'faculty/approve',{revision:0});const start=await post(a,'student/start',{consent:true});const s=(await start.json()).session;
  expect((await post(b,'student/end',{session_id:s.id,revision:0})).status()).toBe(404);
  expect((await post(a,'student/end',{session_id:'invalid-id',revision:0})).status()).toBe(400);
 }finally{await a.dispose();await b.dispose();}
});
test('mobile demo layout and consent withdrawal before start',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.goto('/demo');await page.getByRole('button',{name:'Create local demo workspace',exact:true}).click();
 await page.getByRole('button',{name:'Approve bank v1'}).click();await page.getByRole('button',{name:'Continue to student'}).click();
 await expect(page.getByRole('checkbox')).not.toBeChecked();await page.getByRole('checkbox').check();await page.getByRole('checkbox').uncheck();
 await expect(page.getByRole('button',{name:'Start Interview',exact:true})).toBeDisabled();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
