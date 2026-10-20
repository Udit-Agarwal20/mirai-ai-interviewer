# Privacy note

Offline demo uses synthetic questions/responses and named developer fixtures. It requests no real student identity, microphone access or audio recording. Transcript, mock evaluation and override records live in server memory for up to one hour; restarting deletes them. There is no durable backup. HttpOnly, SameSite, role-path cookies expire after one hour. Local workspace creators receive both fixture roles: this is not production access control.

No provider calls are made by the offline path. The separately gated voice path would transmit audio via LiveKit to Deepgram, text to Gemini through LiveKit Inference and synthesis text to Sarvam. Account-specific provider retention, Sarvam settings, consent policy, institutional retention/deletion and production faculty scope remain UNVERIFIED. No assertion of zero provider-side retention is made.

No private recordings or real student data should be included in the submission. Future volunteer recordings require explicit recording consent and approved handling. Keys belong only in ignored local environment files and must never be included in logs, video, screenshots or Git.
