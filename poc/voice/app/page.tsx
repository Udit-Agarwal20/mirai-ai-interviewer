"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import LivePanel from "./live-panel";
import JudgePanel from "./judge-panel";

type Health = {
  mode: string;
  liveConnectionsEnabled: boolean;
  message: string;
  providers: { name: string; missing: string[] }[];
};

const initialMessage = "Microphone off. Consent and a button click are required.";

function microphoneError(error: unknown) {
  const name = error instanceof DOMException ? error.name : "UnknownError";
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone permission denied. Allow access in your browser settings, then retry.";
  if (name === "NotFoundError") return "No microphone found. Connect a microphone, then retry.";
  if (name === "NotReadableError") return "Microphone unavailable. Close other apps using it, then retry.";
  return "Could not access the microphone. Check your device and browser settings, then retry.";
}

export default function Page() {
  if (process.env.NEXT_PUBLIC_POC_MODE === "hosted") {
    return <JudgePanel />;
  }

  const [consent, setConsent] = useState(false);
  const [preflight, setPreflight] = useState(false);
  const [state, setState] = useState<"off" | "requesting" | "active">("off");
  const [message, setMessage] = useState(initialMessage);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState("");
  const stream = useRef<MediaStream | null>(null);
  const generation = useRef(0);
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const release = useCallback(() => {
    generation.current += 1;
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = null;
    const previous = stream.current;
    stream.current = null;
    previous?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
  }, []);

  const stop = useCallback((reason = "Microphone stopped. Nothing was recorded or transmitted.") => {
    release();
    setState("off");
    setMessage(reason);
  }, [release]);

  useEffect(() => {
    const hidden = () => { if (document.hidden) stop("Microphone stopped because this tab was hidden."); };
    const leaving = () => stop();
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leaving);
    return () => {
      release();
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", leaving);
    };
  }, [release, stop]);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/poc/health", { cache: "no-store", signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error("Local health failed"); return response.json(); })
      .then(setHealth)
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setHealthError("Local setup check unavailable. Restart the local server and reload this page.");
      });
    return () => controller.abort();
  }, []);

  async function checkMicrophone() {
    if (!consent || state !== "off") return;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setMessage("Microphone access is unsupported here. Use a supported browser on localhost or HTTPS.");
      return;
    }
    release();
    const request = generation.current;
    setState("requesting");
    setMessage("Waiting for browser permission. You can cancel this check.");
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      // A late permission grant must not resume capture after cancellation or unmount.
      if (request !== generation.current) {
        acquired.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = acquired;
      if (acquired.getAudioTracks().length === 0) {
        stop("No audio track was available. Check your microphone and retry.");
        return;
      }
      acquired.getAudioTracks().forEach((track) => {
        track.onended = () => stop("Microphone disconnected or permission revoked. Reconnect it, then retry.");
      });
      setPreflight(true);
      setState("active");
      setMessage("Microphone access granted. This checks access, not audio quality. It stops automatically after 10 seconds.");
      timeout.current = setTimeout(() => stop("10-second check finished. Microphone stopped."), 10_000);
    } catch (error) {
      if (request !== generation.current) return;
      stop(microphoneError(error));
    }
  }

  return <main>
    <header><span className="brand">MIRAI</span><span className="badge">TASK-003B · Controlled experiment</span></header>
    <h1>Check your microphone.</h1>
    <p className="intro">Prepare for the voice proof of concept. This is a local device check, not a viva or an AI conversation.</p>
    <section aria-labelledby="connection-heading">
      <h2 id="connection-heading">Connection</h2>
      <p className="status">Separate approval required for live services</p>
      <p>The microphone check below stays local. The separate live experiment transmits audio through LiveKit to Deepgram and sends recognized text to LiveKit Inference; Sarvam generates speech.</p>
    </section>
    <section aria-labelledby="microphone-heading">
      <h2 id="microphone-heading">Local microphone check</h2>
      <label className="consent"><input type="checkbox" checked={consent} onChange={(event) => {
        setConsent(event.target.checked);
        if (!event.target.checked) { setPreflight(false); stop("Consent withdrawn. Microphone stopped."); }
      }} /> <span>I consent to a local microphone check for up to 10 seconds. The microphone will be opened but the audio will not be stored or transmitted.</span></label>
      <div className="actions">
        <button disabled={!consent || state !== "off"} onClick={checkMicrophone}>Check microphone</button>
        <button className="secondary" disabled={state === "off"} onClick={() => stop()}>{state === "requesting" ? "Cancel check" : "Stop microphone"}</button>
      </div>
      <p role="status" aria-live="polite" data-testid="microphone-status">{message}</p>
    </section>
    <section aria-labelledby="setup-heading">
      <h2 id="setup-heading">Provider readiness</h2>
      <p>Development spending limit: <strong>₹0 — free credits only.</strong></p>
      {healthError ? <p role="alert">{healthError}</p> : !health ? <p>Checking local configuration…</p> : <>
        <p>{health.message}</p>
        <ul>{health.providers.map((provider) => <li key={provider.name}>
          <strong>{provider.name}</strong><br />
          {provider.missing.length ? <>Missing: <code>{provider.missing.join(", ")}</code></> : "Configuration present; account access, credit and billing safety not verified."}
        </li>)}</ul>
      </>}
      <p className="note">Store credentials only in your local environment file. Never paste keys into chat or use NEXT_PUBLIC variables for secrets.</p>
    </section>
    <LivePanel preflight={preflight} releasePreflight={() => stop()} />
    <footer>Developer fixture only. No grading, recording, transcript persistence, or production examination controller.</footer>
  </main>;
}
