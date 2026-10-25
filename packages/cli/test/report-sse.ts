import { get, type IncomingHttpHeaders } from 'node:http';

/** One message of an event stream: its `id:` and its `data:` parsed as JSON. */
export interface StreamMessage {
  readonly id: string;
  readonly data: { readonly seq: number; readonly type: string };
}

/** Reads the messages of a `text/event-stream` response as they come, comments left out. */
export class StreamReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private comments = 0;

  constructor(response: Response) {
    if (response.body === null) throw new Error('The event stream has no body');
    this.reader = response.body.getReader();
  }

  /** The next `count` messages; fewer when the stream ends first. */
  async next(count: number): Promise<StreamMessage[]> {
    const messages: StreamMessage[] = [];
    while (messages.length < count) {
      const block = await this.nextBlock();
      if (block === null) return messages;
      const message = parseBlock(block);
      if (message === null) this.comments += 1;
      else messages.push(message);
    }
    return messages;
  }

  /** How many comment blocks (heartbeats) the stream has sent so far. */
  get commentCount(): number {
    return this.comments;
  }

  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }

  private async nextBlock(): Promise<string | null> {
    for (;;) {
      const end = this.buffer.indexOf('\n\n');
      if (end !== -1) {
        const block = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 2);
        return block;
      }
      const { value, done } = await this.reader.read();
      if (done) return null;
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }
}

/** A message block, or `null` for a comment (`: ping`). */
function parseBlock(block: string): StreamMessage | null {
  const lines = block.split('\n');
  const id = lines.find((line) => line.startsWith('id: '))?.slice('id: '.length);
  const data = lines.find((line) => line.startsWith('data: '))?.slice('data: '.length);
  if (id === undefined || data === undefined) return null;
  return { id, data: JSON.parse(data) as StreamMessage['data'] };
}

export interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

/**
 * GETs `path` exactly as written: `fetch` resolves `..` and `%2e%2e` segments before it sends a request,
 * so a traversal attempt has to go out through `node:http`.
 */
export function rawGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = get({ host: '127.0.0.1', port, path, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
      response.on('error', reject);
    });
    request.on('error', reject);
  });
}
