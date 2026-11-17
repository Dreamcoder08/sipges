/** One server-sent event: its name (`message` when the stream names none) and its data lines. */
export type ServerSentEvent = { readonly event: string; readonly data: string };

const LINE_BREAK = /\r\n|\r|\n/;

/**
 * Reads the events of a `text/event-stream` body as they arrive, for a stream that `EventSource`
 * cannot open (a POST with a body). It follows the HTML event-stream format: chunks may cut a line,
 * a line break or a character anywhere; `:` lines are comments (heartbeats); `data` lines join with
 * a line break; a blank line ends an event, and one the stream cut off before it is dropped. `id`
 * and `retry` are ignored: the caller does not reconnect. Stopping early (a `break`, or the
 * request's signal) cancels the body.
 */
export async function* readServerSentEvents(
  body: ReadableStream<BufferSource>,
): AsyncGenerator<ServerSentEvent> {
  // Not `for await` over the stream: Safari's streams are not async iterable.
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let event = '';
  let data: string[] = [];
  let finished = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        finished = true;
        return;
      }
      buffer += value;
      for (;;) {
        const match = LINE_BREAK.exec(buffer);
        // A trailing \r may be the first half of \r\n: wait for the next chunk.
        if (!match || (match[0] === '\r' && match.index === buffer.length - 1)) break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (line === '') {
          if (data.length) yield { event: event || 'message', data: data.join('\n') };
          event = '';
          data = [];
          continue;
        }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const raw = colon === -1 ? '' : line.slice(colon + 1);
        const text = raw.startsWith(' ') ? raw.slice(1) : raw;
        if (field === 'event') event = text;
        else if (field === 'data') data.push(text);
      }
    }
  } finally {
    // Left early (a break or an error): let go of the connection too.
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
