import "server-only";
import requirements from "../provider-env.json";

// Presence is not authentication, available credit, or permission to spend.
// No provider SDK, network request, token generation, or enable flag belongs here.
export function localReadiness() {
  return {
    status: "ok",
    mode: "local-only",
    liveConnectionsEnabled: false,
    message: "This offline check makes no provider calls. Live activation requires separately approved account checks and an explicitly armed local agent.",
    providers: Object.entries(requirements).map(([name, keys]) => ({
      name,
      missing: keys.filter((key) => !process.env[key]?.trim())
    }))
  };
}
