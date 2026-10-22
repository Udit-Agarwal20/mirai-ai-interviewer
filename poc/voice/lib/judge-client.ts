import { Room, RoomEvent, Track, createLocalAudioTrack, type LocalAudioTrack } from "livekit-client";

export type JudgeSessionState = "idle" | "requesting" | "waiting_for_agent" | "live" | "ended" | "error";

export class JudgeLiveSession {
  private room: Room | null = null;
  private track: LocalAudioTrack | null = null;
  private audioElements: HTMLAudioElement[] = [];
  private state: JudgeSessionState = "idle";
  private currentRoomName = "";
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private remainingSeconds = 60;
  private generation = 0;

  constructor(
    private onState: (state: JudgeSessionState, detail: string) => void,
    private onTimer: (remaining: number) => void,
    private audioParent: HTMLElement,
    private roomFactory = () => new Room({ adaptiveStream: false, dynacast: false }),
    private request: typeof fetch = (...args) => globalThis.fetch(...args)
  ) {}

  getState(): JudgeSessionState {
    return this.state;
  }

  async start(inviteCode: string, consent: boolean, preflight: boolean): Promise<void> {
    if (!consent || !preflight) {
      this.transition("error", "Microphone check and consent are required before starting.");
      return;
    }
    if (this.state === "live" || this.state === "waiting_for_agent" || this.state === "requesting") {
      return;
    }

    const gen = ++this.generation;
    this.transition("requesting", "Validating invitation and requesting secure LiveKit session…");

    let sessionData: { token: string; url: string; room: string; identity: string; maxDuration: number };
    try {
      const response = await this.request("/api/poc/judge/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ inviteCode, consent: true, preflight: true }),
        signal: AbortSignal.timeout(15_000),
      });

      if (gen !== this.generation) {
        if (response.ok) {
          try {
            const d = await response.json();
            await this.remoteStop(d.room);
          } catch {}
        }
        return;
      }

      if (!response.ok) {
        let errMessage = "Admission request rejected.";
        try {
          const errData = await response.json();
          if (errData && typeof errData.message === "string") {
            errMessage = errData.message;
          }
        } catch {}
        this.transition("error", errMessage);
        return;
      }

      sessionData = await response.json();
    } catch {
      if (gen === this.generation) {
        this.transition("error", "Failed to connect to the session server. Please check your connection.");
      }
      return;
    }

    if (gen !== this.generation) {
      void this.remoteStop(sessionData.room);
      return;
    }

    this.currentRoomName = sessionData.room;
    this.remainingSeconds = sessionData.maxDuration || 60;
    this.onTimer(this.remainingSeconds);

    this.transition("waiting_for_agent", "Connected to session room. Waiting for AI interviewer (free-tier cold start may take up to 30s)…");

    try {
      const room = (this.room = this.roomFactory());

      const activateLive = () => {
        if (gen === this.generation && this.state === "waiting_for_agent") {
          this.transition("live", "AI interviewer connected. Maximum 60 seconds and 3 candidate answers.");
          this.startCountdown();
        }
      };

      room.on(RoomEvent.ParticipantConnected, () => {
        activateLive();
      });

      room.on(RoomEvent.Disconnected, () => {
        if (gen === this.generation && (this.state === "live" || this.state === "waiting_for_agent")) {
          this.stop("Session disconnected.");
        }
      });

      room.on(RoomEvent.TrackSubscribed, (subscribedTrack) => {
        if (subscribedTrack.kind === Track.Kind.Audio) {
          const el = subscribedTrack.attach();
          el.autoplay = true;
          this.audioElements.push(el);
          this.audioParent.appendChild(el);
          void el.play().catch(() => {});
          activateLive();
        }
      });

      await room.connect(sessionData.url, sessionData.token, { autoSubscribe: true, maxRetries: 0 });
      if (gen !== this.generation) {
        void room.disconnect();
        void this.remoteStop(sessionData.room);
        return;
      }

      await room.startAudio();

      for (const p of room.remoteParticipants.values()) {
        if (p.identity.includes("agent")) {
          activateLive();
        }
      }

      const micTrack = (this.track = await createLocalAudioTrack({ echoCancellation: true, noiseSuppression: true }));
      if (gen !== this.generation) {
        micTrack.stop();
        void room.disconnect();
        void this.remoteStop(sessionData.room);
        return;
      }

      await room.localParticipant.publishTrack(micTrack, { source: Track.Source.Microphone });
    } catch {
      if (gen === this.generation) {
        this.stop("WebRTC connection failed. Verify microphone permission and network access.", true);
      }
    }
  }

  private startCountdown() {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    this.countdownTimer = setInterval(() => {
      this.remainingSeconds -= 1;
      this.onTimer(Math.max(0, this.remainingSeconds));
      if (this.remainingSeconds <= 0) {
        this.stop("60-second judge interview limit reached. Session completed.");
      }
    }, 1000);
  }

  private async remoteStop(roomName: string): Promise<boolean> {
    if (!roomName) return true;
    try {
      const response = await this.request("/api/poc/judge/session", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ room: roomName }),
        keepalive: true,
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) {
        let msg = "Room deletion could not be verified with voice provider. Server 60-second timer will enforce termination.";
        try {
          const errData = await response.json();
          if (errData && typeof errData.message === "string") {
            msg = errData.message;
          }
        } catch {}
        if (this.state === "ended") {
          this.transition("ended", `Interview ended locally. Notice: ${msg}`);
        }
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async stop(reason: string = "Interview ended.", isError = false) {
    ++this.generation;

    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }

    if (this.track) {
      this.track.stop();
      this.track = null;
    }

    for (const el of this.audioElements) {
      el.pause();
      el.srcObject = null;
      el.remove();
    }
    this.audioElements = [];

    const room = this.room;
    this.room = null;

    if (room) {
      await room.disconnect().catch(() => {});
    }

    const roomToClean = this.currentRoomName;
    this.currentRoomName = "";
    if (roomToClean) {
      void this.remoteStop(roomToClean);
    }

    this.transition(isError ? "error" : "ended", reason);
  }

  private transition(newState: JudgeSessionState, detail: string) {
    this.state = newState;
    this.onState(newState, detail);
  }
}
