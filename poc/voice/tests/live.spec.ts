import { test, expect } from "@playwright/test";
import { Room, RoomEvent, type LocalAudioTrack } from "livekit-client";
import { LiveConversation } from "../lib/live-client";

const origin="http://127.0.0.1:3000";
const developerKey="synthetic-developer-key-for-local-tests-only";
test("local access rejects missing origin, wrong key, forged and expired cookies",async({request})=>{
  expect((await request.post('/api/poc/access',{data:{key:developerKey}})).status()).toBe(403);
  expect((await request.post('/api/poc/access',{headers:{Origin:origin},data:{key:'wrong'}})).status()).toBe(403);
  for(const cookie of ['mirai_poc=forged','mirai_poc='+ 'a'.repeat(32)+'.1.'+'b'.repeat(64)]) {
    expect((await request.post('/api/poc/session',{headers:{Origin:origin,Cookie:cookie},data:{consent:true,preflight:true}})).status()).toBe(403);
  }
});
test("authorized malformed start denied; control cookie private; no secrets in page",async({request,page})=>{
  const response=await request.post('/api/poc/access',{headers:{Origin:origin},data:{key:developerKey}});
  expect(response.status()).toBe(200);
  expect(response.headers()['set-cookie']).toContain('HttpOnly');
  expect(response.headers()['set-cookie']).toContain('SameSite=Strict');
  const cookie=response.headers()['set-cookie'].split(';')[0];
  for(const data of [{consent:false,preflight:true},{consent:true,preflight:false},{consent:true,preflight:true,room:'foreign'}]) {
    expect((await request.post('/api/poc/session',{headers:{Origin:origin,Cookie:cookie},data})).status()).toBe(400);
  }
  expect((await request.post('/api/poc/session',{headers:{Origin:'http://evil.example',Cookie:cookie},data:{consent:true,preflight:true}})).status()).toBe(403);
  const allowed=await request.post('/api/poc/session',{headers:{Origin:origin,Cookie:cookie},data:{consent:true,preflight:true}});
  expect(allowed.status()).toBe(403);
  expect(await allowed.json()).toEqual({error:'live_approval_or_configuration_missing'});
  expect((await request.get('/api/poc/session',{headers:{'X-Poc-Request':'1',Cookie:cookie}})).status()).toBe(404);
  expect((await request.post('/api/poc/access',{headers:{Origin:origin,'X-Forwarded-Host':'evil.example'},data:{key:developerKey}})).status()).toBe(403);
  await page.goto('/');
  expect(await page.content()).not.toContain(developerKey);
  expect(await page.content()).not.toContain('synthetic-control-secret-for-local-tests-only');
});
test("live consent unchecked and start gated by access and preflight",async({page})=>{
  await page.goto('/');
  await expect(page.getByRole('checkbox').nth(1)).not.toBeChecked();
  await expect(page.getByRole('button',{name:'Start approved live test'})).toBeDisabled();
  await page.getByRole('checkbox').nth(1).check();
  await expect(page.getByRole('button',{name:'Start approved live test'})).toBeDisabled();
});

function harness(options:{delayCapture?:boolean;delayStart?:boolean;rejectCapture?:boolean;rejectConnect?:boolean;responseStatus?:number;responseBody?:unknown}={}) {
  const handlers=new Map<string, (...args: unknown[])=>void>();
  let stops=0, starts=0, deletes=0, disconnects=0, releaseCapture:()=>void=()=>{}, releaseStart:()=>void=()=>{};
  const states:string[]=[];
  const details:string[]=[];
  const track={stop:()=>{stops++;}} as LocalAudioTrack;
  const room={on:(event:string,cb:(...args:unknown[])=>void)=>{handlers.set(event,cb);},
    connect:async()=>{ if(options.rejectConnect) throw new Error('synthetic_webrtc_failure'); },startAudio:async()=>{},disconnect:async()=>{disconnects++;},
    localParticipant:{publishTrack:async()=>{}}} as unknown as Room;
  const capture=async()=>{
    if(options.delayCapture) await new Promise<void>(resolve=>{releaseCapture=resolve;});
    if(options.rejectCapture) throw new DOMException('synthetic','NotAllowedError');
    return track;
  };
  const request=(async(_url:unknown,init?:RequestInit)=>{
    if(init?.method==='POST') {
      starts++;
      if(options.delayStart) await new Promise<void>(resolve=>{releaseStart=resolve;});
      if(options.responseStatus && options.responseStatus >= 400) {
        return Response.json(options.responseBody ?? {error:'start_denied'}, {status: options.responseStatus});
      }
      return Response.json({token:'synthetic',url:'wss://synthetic.livekit.cloud'});
    }
    if(init?.method==='DELETE') {deletes++;return Response.json({state:'ended'});}
    return Response.json({state:'active'});
  }) as typeof fetch;
  const client=new LiveConversation((s,d)=>{states.push(s);details.push(d);},()=>{},{} as HTMLElement,()=>room,capture,request);
  return {client,handlers,states,details,counts:()=>({stops,starts,deletes,disconnects}),releaseCapture:()=>releaseCapture(),releaseStart:()=>releaseStart()};
}
test("mocked lifecycle rejects no consent, suppresses duplicates and stops capture synchronously",async()=>{
  const h=harness();
  await expect(h.client.start(false,true)).rejects.toThrow('Consent');
  await h.client.start(true,true);await h.client.start(true,true);
  expect(h.counts().starts).toBe(1);
  const ending=h.client.stop();expect(h.counts().stops).toBe(1);await ending;
  expect(h.counts().deletes).toBe(1);expect(h.states).toContain('connected');
});
test("mocked consent withdrawal during permission request releases late capture",async()=>{
  const h=harness({delayCapture:true});const starting=h.client.start(true,true);
  await expect.poll(()=>h.counts().starts).toBe(1);
  await new Promise(r=>setTimeout(r,20));
  await h.client.stop('Consent withdrawn');h.releaseCapture();await starting;
  expect(h.counts().stops).toBe(1);expect(h.states).not.toContain('connected');
});
test("mocked cancellation during start terminates late server session",async()=>{
  const h=harness({delayStart:true});const starting=h.client.start(true,true);
  await h.client.stop();h.releaseStart();await starting;
  expect(h.counts().deletes).toBe(2);expect(h.states).not.toContain('connected');
});
test("mocked disconnect and reconnect both terminate rather than open another session",async()=>{
  for(const event of [RoomEvent.Disconnected,RoomEvent.Reconnecting]) {
    const h=harness();await h.client.start(true,true);h.handlers.get(event)?.();
    await expect.poll(()=>h.counts().stops).toBe(1);
    expect(h.counts().starts).toBe(1);await h.client.stop();
  }
});
test("mocked microphone acquisition failure terminates remote session",async()=>{
  const h=harness({rejectCapture:true});await h.client.start(true,true);
  expect(h.states).toContain('error');expect(h.counts().deletes).toBe(1);expect(h.counts().disconnects).toBe(1);
});

test("browser manual start reaches real unarmed supervisor without a provider connection",async({page,context})=>{
  const external:string[]=[];
  await context.route('**/*',route=>{
    if(new URL(route.request().url()).origin!==origin) { external.push(route.request().url());return route.abort(); }
    return route.continue();
  });
  await page.addInitScript(()=>{
    const counter={calls:0,stops:0};Object.assign(window,{localMic:counter});
    Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{
      counter.calls++;
      const track={stop:()=>{counter.stops++;},onended:null};
      return {getTracks:()=>[track],getAudioTracks:()=>[track]};
    }});
  });
  await page.goto('/');
  await page.getByRole('checkbox').first().check();
  await page.getByRole('button',{name:'Check microphone',exact:true}).click();
  await expect(page.getByTestId('microphone-status')).toContainText('access granted');
  await page.getByLabel('Local developer access key').fill(developerKey);
  await page.getByRole('button',{name:'Unlock local controls'}).click();
  await expect(page.getByTestId('live-status')).toContainText('Local access granted');
  await page.getByRole('checkbox').nth(1).check();
  await page.getByRole('button',{name:'Start approved live test'}).click();
  await expect(page.getByTestId('live-status')).toContainText('start denied');
  expect(await page.evaluate(()=>(window as unknown as {localMic:{calls:number;stops:number}}).localMic)).toEqual({calls:1,stops:1});
  expect(external).toEqual([]);
});

test("mocked denial paths distinguish auth expired, approval consumed, timeout and agent unreachable",async()=>{
  for (const tc of [
    { status: 403, body: { error: 'unauthorized' }, expected: 'Developer authentication expired' },
    { status: 403, body: { error: 'live_approval_or_configuration_missing' }, expected: 'Live approval expired' },
    { status: 409, body: { error: 'one_session_approval_consumed' }, expected: 'One-session approval already consumed' },
    { status: 502, body: { error: 'session_start_failed' }, expected: 'LiveKit room preparation failed' },
    { status: 503, body: { error: 'local_agent_unavailable' }, expected: 'Local Python agent unreachable' },
    { status: 504, body: { error: 'agent_start_timeout' }, expected: 'Local agent start timed out' },
  ]) {
    const h = harness({ responseStatus: tc.status, responseBody: tc.body });
    await h.client.start(true, true);
    expect(h.states).toContain('error');
    const lastDetail = h.details[h.details.length - 1];
    expect(lastDetail).toContain(tc.expected);
  }
});

test("mocked WebRTC connection failure surfaces RTC connection diagnostic",async()=>{
  const h = harness({ rejectConnect: true });
  await h.client.start(true, true);
  expect(h.states).toContain('error');
  expect(h.details.some(d => d.includes('RTC connection failed'))).toBe(true);
});

test("browser shows clear prerequisite hints when consent or unlock is missing",async({page})=>{
  await page.goto('/');
  await expect(page.getByTestId('live-prereq-hint')).toContainText('developer access');
  await expect(page.getByTestId('live-prereq-hint')).toContainText('microphone check');
  await expect(page.getByTestId('live-prereq-hint')).toContainText('live consent');
});

test("browser real Start button click dispatches exactly one POST /api/poc/session with strict payload and safe error", async ({ page, context }) => {
  const external: string[] = [];
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) {
      external.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });

  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        const track = { stop: () => {}, onended: null };
        return { getTracks: () => [track], getAudioTracks: () => [track] };
      }
    });
  });

  const postRequests: { url: string; method: string; body: unknown }[] = [];
  await page.route('**/api/poc/session', async (route) => {
    if (route.request().method() === 'POST') {
      postRequests.push({
        url: route.request().url(),
        method: route.request().method(),
        body: JSON.parse(route.request().postData() ?? '{}')
      });
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'live_approval_or_configuration_missing' })
      });
      return;
    }
    if (route.request().method() === 'DELETE') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ state: 'ended' })
      });
      return;
    }
    await route.continue();
  });

  await page.goto('/');

  // 1. Fill developer key and unlock
  await page.getByLabel('Local developer access key').fill(developerKey);
  await page.getByRole('button', { name: 'Unlock local controls' }).click();
  await expect(page.getByTestId('live-status')).toContainText('Local access granted');

  // 2. Local microphone check
  await page.getByRole('checkbox').first().check();
  await page.getByRole('button', { name: 'Check microphone', exact: true }).click();
  await expect(page.getByTestId('microphone-status')).toContainText('access granted');

  // 3. Live consent
  await page.getByRole('checkbox').nth(1).check();

  // 4. Verify Start button is enabled and click it
  const startButton = page.getByRole('button', { name: 'Start approved live test' });
  await expect(startButton).toBeEnabled();
  await startButton.click();

  // 5. Assert exactly one POST /api/poc/session was dispatched with exact payload
  await expect.poll(() => postRequests.length).toBe(1);
  expect(postRequests[0].body).toEqual({ consent: true, preflight: true });

  // 6. Assert safe error text displayed
  await expect(page.getByTestId('live-status')).toContainText('start denied: Live approval expired or configuration missing');

  // 7. Assert no external provider endpoints reached
  expect(external).toEqual([]);
});

test("browser Start button displays specific safe error for each mocked server status code (403, 409, 502, 503, 504)", async ({ page, context }) => {
  const cases = [
    { status: 403, body: { error: 'unauthorized' }, expected: 'Developer authentication expired or missing' },
    { status: 409, body: { error: 'one_session_approval_consumed' }, expected: 'One-session approval already consumed' },
    { status: 502, body: { error: 'session_start_failed' }, expected: 'LiveKit room preparation failed' },
    { status: 503, body: { error: 'local_agent_unavailable' }, expected: 'Local Python agent unreachable' },
    { status: 504, body: { error: 'agent_start_timeout' }, expected: 'Local agent start timed out while preparing room' },
  ];

  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        const track = { stop: () => {}, onended: null };
        return { getTracks: () => [track], getAudioTracks: () => [track] };
      }
    });
  });

  for (const tc of cases) {
    let postCount = 0;
    await page.unroute('**/api/poc/session');
    await page.route('**/api/poc/session', async (route) => {
      if (route.request().method() === 'POST') {
        postCount++;
        await route.fulfill({
          status: tc.status,
          contentType: 'application/json',
          body: JSON.stringify(tc.body)
        });
        return;
      }
      if (route.request().method() === 'DELETE') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'ended' }) });
        return;
      }
      await route.continue();
    });

    await page.goto('/');
    await page.getByLabel('Local developer access key').fill(developerKey);
    await page.getByRole('button', { name: 'Unlock local controls' }).click();
    await page.getByRole('checkbox').first().check();
    await page.getByRole('button', { name: 'Check microphone', exact: true }).click();
    await expect(page.getByTestId('microphone-status')).toContainText('access granted');
    await page.getByRole('checkbox').nth(1).check();

    const startButton = page.getByRole('button', { name: 'Start approved live test' });
    await expect(startButton).toBeEnabled();
    await startButton.click();

    await expect(page.getByTestId('live-status')).toContainText(tc.expected);
    // Assert exactly one POST was made (no automatic retries)
    expect(postCount).toBe(1);
  }
});

test("browser tab-hidden cancels session cleanly without automatic second POST", async ({ page }) => {
  let postCount = 0;
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      value: async () => {
        const track = { stop: () => {}, onended: null };
        return { getTracks: () => [track], getAudioTracks: () => [track] };
      }
    });
  });

  await page.route('**/api/poc/session', async (route) => {
    if (route.request().method() === 'POST') {
      postCount++;
      await new Promise(r => setTimeout(r, 150));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ token: 'mock-token', url: 'wss://synthetic.livekit.cloud' })
      });
      return;
    }
    if (route.request().method() === 'DELETE') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'ended' }) });
      return;
    }
    await route.continue();
  });

  await page.goto('/');
  await page.getByLabel('Local developer access key').fill(developerKey);
  await page.getByRole('button', { name: 'Unlock local controls' }).click();
  await page.getByRole('checkbox').first().check();
  await page.getByRole('button', { name: 'Check microphone', exact: true }).click();
  await expect(page.getByTestId('microphone-status')).toContainText('access granted');
  await page.getByRole('checkbox').nth(1).check();

  const startButton = page.getByRole('button', { name: 'Start approved live test' });
  await expect(startButton).toBeEnabled();
  await startButton.click();

  // Trigger tab hidden
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  await expect(page.getByTestId('live-status')).toContainText('Page hidden or navigation cancellation');
  // Confirm no second POST was attempted
  expect(postCount).toBe(1);
});
