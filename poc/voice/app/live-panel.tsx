"use client";
import { useEffect, useRef, useState } from "react";
import { LiveConversation, type LiveStatus } from "../lib/live-client";

export default function LivePanel({preflight,releasePreflight}:{preflight:boolean;releasePreflight:()=>void}) {
  const [consent,setConsent]=useState(false);
  const [access,setAccess]=useState(false);
  const [key,setKey]=useState("");
  const [state,setState]=useState<LiveStatus>("off");
  const [detail,setDetail]=useState("Live activation is not approved yet. Local tests consume no credits.");
  const [metrics,setMetrics]=useState<unknown>(null);
  const [playback,setPlayback]=useState<unknown[]>([]);
  const audio=useRef<HTMLDivElement>(null);
  const client=useRef<LiveConversation|null>(null);
  useEffect(()=>{
    const live=new LiveConversation((s,d)=>{setState(s);setDetail(d);},data=>{
      if(data && typeof data === "object" && "event" in data) setPlayback(previous=>[...previous,data].slice(-64));
      else setMetrics(data);
    },audio.current!);
    client.current=live;
    const leave=()=>{ void live.stop("Page hidden or navigation cancellation: session stopped."); };
    const hidden=()=>{if(document.hidden) leave();};
    window.addEventListener("pagehide",leave);
    document.addEventListener("visibilitychange",hidden);
    return ()=>{window.removeEventListener("pagehide",leave);document.removeEventListener("visibilitychange",hidden);void live.stop();};
  },[]);
  useEffect(()=>{if(!preflight) void client.current?.stop("Complete the local microphone check before starting");},[preflight]);
  async function unlock() {
    try {
      const response=await fetch("/api/poc/access",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key})});
      setKey("");
      if(!response.ok) throw new Error();
      setAccess(true);setDetail("Local access granted. This does not approve live provider use.");
    } catch { setDetail("Local access denied. Configure POC_DEVELOPER_KEY and POC_CONTROL_SECRET; never enter provider keys here."); }
  }
  const running=["connecting","connected","reconnecting","stopping"].includes(state);
  const missingPrereqs: string[] = [];
  if (!access) missingPrereqs.push("developer access");
  if (!preflight) missingPrereqs.push("microphone check");
  if (!consent) missingPrereqs.push("live consent");

  function handleStart() {
    if (running) return;
    if (!access || !preflight || !consent) {
      const missing: string[] = [];
      if (!access) missing.push("developer access required");
      if (!preflight) missing.push("microphone check required");
      if (!consent) missing.push("live consent required");
      setState("error");
      setDetail(`Start click not dispatched: ${missing.join(", ")}.`);
      return;
    }
    releasePreflight();
    void client.current?.start(consent, preflight).catch(() => {});
  }

  return <section aria-labelledby="live-heading">
    <h2 id="live-heading">Controlled live experiment</h2>
    <p>Developer-only HTTP idempotency fixture. One session, up to 120 seconds and five answers. ₹0 out-of-pocket limit; existing free credits only.</p>
    <label>Local developer access key <input type="password" autoComplete="off" value={key} onChange={e=>setKey(e.target.value)} /></label>
    <button disabled={!key || running} onClick={()=>void unlock()}>Unlock local controls</button>
    <label className="consent"><input type="checkbox" checked={consent} onChange={e=>{
      setConsent(e.target.checked);
      if(!e.target.checked) { releasePreflight(); void client.current?.stop("Live consent withdrawn"); }
    }} /><span>I consent to this developer voice test: audio passes through LiveKit to Deepgram; recognized answers go to LiveKit Inference and its Google model; Sarvam processes interviewer text to generate speech. This PoC does not save recordings or transcripts. Provider retention terms still apply. I will not share personal or student data.</span></label>
    {missingPrereqs.length > 0 && !running && <p className="note" data-testid="live-prereq-hint">Prerequisites before starting: {missingPrereqs.join(", ")}.</p>}
    <div className="actions">
      <button disabled={!consent || !preflight || !access || running} onClick={handleStart}>Start approved live test</button>
      <button disabled={!running} onClick={()=>void client.current?.stop()}>End live test</button>
      <button disabled={state!=="connected"} onClick={()=>void client.current?.enablePlayback().catch(()=>setDetail("Playback is blocked by browser permissions."))}>Enable playback</button>
    </div>
    <p role="status" data-testid="live-status">{state}: {detail}</p>
    <div ref={audio} />
    <details><summary>In-memory measurements (no transcript)</summary><pre>{metrics ? JSON.stringify({server:metrics,browser:playback},null,2) : "No live measurements collected."}</pre></details>
  </section>;
}
