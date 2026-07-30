import type { AppServer } from '../appServer.js';
import { APP_SERVER_PROTOCOL_VERSION, parseAppServerRequest } from '../protocol.js';

export interface AppServerWebSocket {
  send(data: string): void;
  on(event: 'message', listener: (data: unknown) => void): void;
}

export class WebSocketAppServerTransport {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly server: AppServer) {}

  attach(socket: AppServerWebSocket): void {
    socket.on('message', data => {
      // Serialize handlers per connection so responses/events cannot interleave
      // across concurrent requests on the same socket.
      this.chain = this.chain
        .then(() => this.receive(socket, data))
        .catch(() => this.receive(socket, data));
    });
  }

  private async receive(socket: AppServerWebSocket, data: unknown): Promise<void> {
    let requestId = '';
    try {
      const text = typeof data === 'string'
        ? data
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : String(data);
      const parsed = JSON.parse(text) as { id?: unknown };
      if (typeof parsed.id === 'string') requestId = parsed.id;
      const response = await this.server.handle(
        parseAppServerRequest(JSON.parse(text)),
        notification => socket.send(JSON.stringify(notification)),
      );
      socket.send(JSON.stringify(response));
    } catch (error) {
      socket.send(JSON.stringify({
        version: APP_SERVER_PROTOCOL_VERSION,
        id: requestId,
        error: {
          code: 'INVALID_REQUEST',
          message: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  }
}
