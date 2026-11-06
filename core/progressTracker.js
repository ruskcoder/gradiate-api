/**
 * Progress reporting for a route.
 *
 * Non-streaming: collects the final status/body; `response()` returns it as JSON.
 * Streaming (`stream: true` in the request): the response starts immediately and
 * each `update()` writes a `{"percent","message"}` chunk followed by a blank
 * line; `complete()`/`error()` write the final JSON and end the stream. This
 * framing is what the web and mobile clients parse, so it is unchanged.
 */

import { json } from './http.js';

const encoder = new TextEncoder();

const STREAM_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
};

class ProgressTracker {
  constructor(streaming = false) {
    this.streaming = streaming;
    this.finished = false;
    this.result = null;
    // How the route ended, for the timing log: "ok", "mfa" or "error <status>".
    this.outcome = null;
    if (streaming) {
      const { readable, writable } = new TransformStream();
      this.readable = readable;
      this.writer = writable.getWriter();
    }
  }

  write(text) {
    // A client that disconnected makes writes reject; nothing to do about it.
    this.writer.write(encoder.encode(text)).catch(() => {});
  }

  update(percent, message) {
    if (this.streaming && !this.finished) {
      this.write(JSON.stringify({ percent, message }) + '\n\n');
    }
  }

  complete(data) {
    if (this.finished) return;
    this.outcome = data?.mfaRequired ? 'mfa' : 'ok';
    if (this.streaming) {
      this.write(JSON.stringify(data));
    } else {
      this.result = { status: 200, body: data };
    }
    this.finish();
  }

  error(statusCode, message) {
    if (this.finished) return;
    this.outcome = `error ${statusCode}`;
    const errorResponse = { success: false, status: statusCode, message };
    if (this.streaming) {
      this.write(JSON.stringify(errorResponse));
    } else {
      this.result = { status: statusCode, body: errorResponse };
    }
    this.finish();
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    if (this.streaming) this.writer.close().catch(() => {});
  }

  /** The Response for this route. Streaming responses are returned before the work ends. */
  response() {
    if (this.streaming) {
      return new Response(this.readable, { status: 200, headers: STREAM_HEADERS });
    }
    const { status, body } = this.result || {
      status: 500,
      body: { success: false, message: 'Internal Server Error' },
    };
    return json(status, body);
  }
}

export default ProgressTracker;
