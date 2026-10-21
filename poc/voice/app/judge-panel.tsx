"use client";

import { useEffect, useRef, useState } from "react";
import { JudgeLiveSession, type JudgeSessionState } from "../lib/judge-client";

export default function JudgePanel() {
  const [inviteCode, setInviteCode] = useState("");
  const [micConsent, setMicConsent] = useState(false);
  const [preflightPassed, setPreflightPassed] = useState(false);
  const [micChecking, setMicChecking] = useState(false);
  const [micMessage, setMicMessage] = useState("Microphone off. Consent and check required.");

  const [liveConsent, setLiveConsent] = useState(false);
  const [sessionState, setSessionState] = useState<JudgeSessionState>("idle");
  const [statusDetail, setStatusDetail] = useState("Enter your private judge invitation code to begin.");
  const [remainingSeconds, setRemainingSeconds] = useState(60);

  const audioContainer = useRef<HTMLDivElement>(null);
  const sessionClient = useRef<JudgeLiveSession | null>(null);
  const micStream = useRef<MediaStream | null>(null);
  const micTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const client = new JudgeLiveSession(
      (state, detail) => {
        setSessionState(state);
        setStatusDetail(detail);
      },
      (seconds) => {
        setRemainingSeconds(seconds);
      },
      audioContainer.current!
    );
    sessionClient.current = client;

    const onVisibility = () => {
      if (document.hidden) {
        void client.stop("Tab hidden: session stopped automatically.");
      }
    };
    const onPageHide = () => {
      void client.stop("Page closed: session stopped.");
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      void client.stop();
    };
  }, []);

  async function runMicCheck() {
    if (!micConsent || micChecking) return;
    setMicChecking(true);
    setMicMessage("Requesting microphone permission…");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      micStream.current = stream;
      setPreflightPassed(true);
      setMicMessage("Microphone access verified. Auto-stopping in 10 seconds.");
      micTimeout.current = setTimeout(() => {
        stopMicCheck("Microphone check completed.");
      }, 10_000);
    } catch {
      setPreflightPassed(false);
      setMicMessage("Microphone permission denied or device not found.");
      setMicChecking(false);
    }
  }

  function stopMicCheck(msg = "Microphone check stopped.") {
    if (micTimeout.current) clearTimeout(micTimeout.current);
    micTimeout.current = null;
    if (micStream.current) {
      micStream.current.getTracks().forEach((t) => t.stop());
      micStream.current = null;
    }
    setMicChecking(false);
    setMicMessage(msg);
  }

  const isRunning = sessionState === "requesting" || sessionState === "waiting_for_agent" || sessionState === "live";
  const canStart = Boolean(inviteCode.trim()) && preflightPassed && liveConsent && !isRunning;

  function handleStart() {
    if (!canStart) return;
    stopMicCheck();
    void sessionClient.current?.start(inviteCode.trim(), liveConsent, preflightPassed);
  }

  function handleStop() {
    void sessionClient.current?.stop("Interview ended by judge.");
  }

  return (
    <main>
      <header>
        <span className="brand">MIRAI</span>
        <span className="badge">Judge Evaluation PoC · Live Voice Viva</span>
      </header>

      <h1>Technical Voice Viva — Judge Evaluation</h1>
      <p className="intro">
        Real-time voice viva evaluating technical concepts using LiveKit WebRTC, Deepgram Nova-3 STT, Gemini 3 Flash, and Sarvam Bulbul v3 TTS.
        Strictly guarded: maximum 60 seconds and 3 candidate answers.
      </p>

      {/* Step 1: Judge Admission */}
      <section aria-labelledby="invitation-heading">
        <h2 id="invitation-heading">1. Private Judge Invitation</h2>
        <p className="status">Restricted hackathon judge access</p>
        <label>
          Judge Invitation Code
          <input
            type="password"
            autoComplete="off"
            placeholder="Enter private code"
            value={inviteCode}
            disabled={isRunning}
            onChange={(e) => setInviteCode(e.target.value)}
          />
        </label>
        <p className="note">
          Two private invitation codes are provisioned for evaluation. Each code permits exactly one interview (maximum 2 sessions globally).
        </p>
      </section>

      {/* Step 2: Microphone Check */}
      <section aria-labelledby="mic-check-heading">
        <h2 id="mic-check-heading">2. Microphone Preflight</h2>
        <label className="consent">
          <input
            type="checkbox"
            checked={micConsent}
            disabled={isRunning}
            onChange={(e) => {
              setMicConsent(e.target.checked);
              if (!e.target.checked) {
                setPreflightPassed(false);
                stopMicCheck("Consent withdrawn.");
              }
            }}
          />
          <span>I consent to a 10-second local microphone check. Audio is not recorded or transmitted during preflight.</span>
        </label>
        <div className="actions">
          <button disabled={!micConsent || micChecking || isRunning} onClick={() => void runMicCheck()}>
            Check microphone
          </button>
          <button className="secondary" disabled={!micChecking} onClick={() => stopMicCheck()}>
            Stop check
          </button>
        </div>
        <p role="status" aria-live="polite" data-testid="judge-mic-status">
          {micMessage}
        </p>
      </section>

      {/* Step 3: Live Consent & Start */}
      <section aria-labelledby="interview-heading">
        <h2 id="interview-heading">3. Start Voice Interview</h2>
        <label className="consent">
          <input
            type="checkbox"
            checked={liveConsent}
            disabled={isRunning}
            onChange={(e) => {
              setLiveConsent(e.target.checked);
              if (!e.target.checked && isRunning) {
                void sessionClient.current?.stop("Live consent withdrawn.");
              }
            }}
          />
          <span>
            I consent to this live evaluation session: microphone audio is transmitted via WebRTC to LiveKit and Deepgram;
            transcribed answers are evaluated by Gemini 3 Flash; Sarvam Bulbul v3 generates the interviewer speech.
            No audio recordings or transcripts are stored. Enforced hard limit: 60 seconds and at most 3 answers.
          </span>
        </label>

        {sessionState === "live" && (
          <div className="live-badge" data-testid="live-timer" style={{ margin: "1rem 0", padding: "0.75rem", background: "rgba(16, 185, 129, 0.1)", border: "1px solid #10b981", borderRadius: "6px" }}>
            <strong>Session Active:</strong> {remainingSeconds}s remaining · Maximum 3 candidate answers
          </div>
        )}

        <div className="actions">
          <button disabled={!canStart} onClick={handleStart} data-testid="start-judge-interview">
            {sessionState === "waiting_for_agent" ? "Waiting for agent…" : "Start interview"}
          </button>
          <button className="secondary" disabled={!isRunning} onClick={handleStop} data-testid="end-judge-interview">
            End interview
          </button>
        </div>

        <p role="status" aria-live="polite" data-testid="judge-session-status">
          <strong>Status:</strong> [{sessionState}] {statusDetail}
        </p>
      </section>

      <div ref={audioContainer} />

      <footer>
        Mirai AI Interviewer — Hackathon Judge Proof of Concept. Enforces strict ₹0 free credit limits, no automated retries, and bounded interview execution.
      </footer>
    </main>
  );
}
