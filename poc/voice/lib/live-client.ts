import { Room, RoomEvent, Track, createLocalAudioTrack, type LocalAudioTrack } from "livekit-client";

export type LiveStatus = "off" | "connecting" | "connected" | "reconnecting" | "stopping" | "ended" | "error";
export class LiveConversation {
  private room: Room | null = null;
  private track: LocalAudioTrack | null = null;
  private generation = 0;
  private active = false;
  private poll: ReturnType<typeof setTimeout> | null = null;
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private audio: HTMLMediaElement[] = [];
  constructor(private notify: (state: LiveStatus, detail: string) => void,
    private metrics: (data: unknown) => void,
    private audioParent: HTMLElement,
    private roomFactory = () => new Room({adaptiveStream:false,dynacast:false,reconnectPolicy:{nextRetryDelayInMs:()=>null}}),
    private capture = () => createLocalAudioTrack({echoCancellation:true,noiseSuppression:true}),
    private request: typeof fetch = fetch) {}

  async start(consent: boolean, preflight: boolean) {
    if (!consent || !preflight) throw new Error("Consent and preflight required");
    if (this.active) return;
    this.active=true;
    const generation=++this.generation;
    this.notify("connecting","Creating one bounded developer session…");
    this.deadline=setTimeout(()=>void this.stop("120-second local limit reached"),120_000);
    try {
      const response=await this.request("/api/poc/session",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({consent:true,preflight:true}),signal:AbortSignal.timeout(15_000)});
      if (!response.ok) throw new Error("Start rejected. Check local agent configuration, approval and account verification.");
      const data=await response.json();
      if (generation!==this.generation) { await this.remoteStop(); return; }
      const room=this.room=this.roomFactory();
      room.on(RoomEvent.Reconnecting,()=>{
        this.notify("reconnecting","Connection lost; this first experiment ends instead of resuming.");
        void this.stop("Connection interrupted");
      });
      room.on(RoomEvent.Disconnected,()=>{ if(this.active) void this.stop("Room disconnected"); });
      room.on(RoomEvent.TrackSubscribed,(track)=>{
        if(track.kind!==Track.Kind.Audio) return;
        const element=track.attach();
        element.autoplay=true;
        element.addEventListener("playing",()=>this.metrics({event:"browser_media_playing",clock:"browser_performance",milliseconds:performance.now(),note:"Media element event; not measured acoustic playback or cross-clock latency"}),{once:true});
        this.audio.push(element); this.audioParent.appendChild(element);
        void element.play().catch(()=>this.notify("connected","Audio playback blocked. Use Enable playback."));
      });
      await room.connect(data.url,data.token,{autoSubscribe:true,maxRetries:0});
      if(generation!==this.generation) { await room.disconnect(); return; }
      await room.startAudio();
      const track=await this.capture();
      if(generation!==this.generation) { track.stop(); await room.disconnect(); return; }
      this.track=track;
      await room.localParticipant.publishTrack(track,{source:Track.Source.Microphone});
      if(generation!==this.generation) { track.stop(); await room.disconnect(); return; }
      this.notify("connected","Developer fixture active. No recording. Maximum five answers.");
      await this.status(generation);
    } catch {
      if(generation===this.generation) await this.stop("Connection failed or start denied. Inspect the local status; do not retry a provider failure automatically.",true);
    }
  }
  async enablePlayback() { await this.room?.startAudio(); for (const a of this.audio) await a.play(); }
  private async status(generation: number) {
    if(generation!==this.generation || !this.active) return;
    try {
      const response=await this.request("/api/poc/session",{method:"GET",headers:{"X-Poc-Request":"1"},cache:"no-store",signal:AbortSignal.timeout(5000)});
      if(!response.ok) throw new Error();
      const data=await response.json(); this.metrics(data);
      if(data.state==="ended" || data.state==="stopping") { await this.stop(data.reason??"Session ended"); return; }
      if(generation===this.generation) this.poll=setTimeout(()=>void this.status(generation),1000);
    } catch { await this.stop("Local session supervisor unavailable",true); }
  }
  private async remoteStop() {
    try {
      const response=await this.request("/api/poc/session",{method:"DELETE",keepalive:true,signal:AbortSignal.timeout(5000)});
      if(response.status===404) return true; // authenticated supervisor confirms no owned session
      if(!response.ok) return false;
      let data=await response.json();
      for(let attempt=0;attempt<12 && data.state!=="ended";attempt++) {
        await new Promise(resolve=>setTimeout(resolve,250));
        const status=await this.request("/api/poc/session",{headers:{"X-Poc-Request":"1"},cache:"no-store",signal:AbortSignal.timeout(5000)});
        if(!status.ok) return false;
        data=await status.json();
      }
      this.metrics(data);
      return data.state==="ended" && data.reason!=="cleanup_unconfirmed_check_dashboard";
    } catch { return false; }
  }
  async stop(reason="Stopped by developer",error=false) {
    const wasActive=this.active;
    this.active=false; ++this.generation;
    if(this.poll) clearTimeout(this.poll);
    if(this.deadline) clearTimeout(this.deadline);
    // Synchronous capture release before any remote operation or await.
    this.track?.stop(); this.track=null;
    for(const element of this.audio) { element.pause(); element.srcObject=null; element.remove(); }
    this.audio=[];
    const room=this.room; this.room=null;
    if(wasActive) this.notify("stopping","Local microphone stopped; terminating remote session…");
    const remote=wasActive ? this.remoteStop() : Promise.resolve(true);
    if(room) await room.disconnect().catch(()=>{});
    const confirmed=await remote;
    this.notify(error || !confirmed ? "error":"ended", reason + (confirmed ? "" : " Local capture stopped; remote cleanup unconfirmed. Check the local agent and LiveKit dashboard."));
  }
}
