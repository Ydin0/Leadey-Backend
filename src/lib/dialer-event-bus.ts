import { EventEmitter } from "node:events";

/** Single-process pub/sub for dialer events (recording-complete, vm-dropped,
 *  amd-detected). Frontend subscribes via SSE on /api/dialer/sessions/:id/events.
 *
 *  Caveat: when we scale to multiple backend instances on Railway, this
 *  needs to be swapped for pg_notify (Postgres LISTEN/NOTIFY) so events
 *  reach the instance that owns the SSE connection. v1 ships single-instance
 *  so this is fine. */
type DialerEvent =
  | { type: "recording-complete"; callRecordId: string; recordingUrl: string }
  | { type: "vm-dropped"; callSid: string; voicemailId: string }
  | { type: "amd-detected"; callSid: string; answeredBy: string };

const emitter = new EventEmitter();
emitter.setMaxListeners(500); // up to 500 concurrent SSE subscriptions

export function publishToCall(callSid: string, event: DialerEvent): void {
  emitter.emit(`call:${callSid}`, event);
}

export function publishToSession(sessionId: string, event: DialerEvent): void {
  emitter.emit(`session:${sessionId}`, event);
}

export function subscribeToCall(
  callSid: string,
  handler: (e: DialerEvent) => void,
): () => void {
  const channel = `call:${callSid}`;
  emitter.on(channel, handler);
  return () => emitter.off(channel, handler);
}

export function subscribeToSession(
  sessionId: string,
  handler: (e: DialerEvent) => void,
): () => void {
  const channel = `session:${sessionId}`;
  emitter.on(channel, handler);
  return () => emitter.off(channel, handler);
}
