import { describe, expect, it } from 'vitest';

import {
  APP_SERVER_PROTOCOL_VERSION,
  parseAppServerRequest,
} from '../src/app-server/index.js';

describe('app-server protocol', () => {
  it('accepts versioned requests and rejects malformed input', () => {
    expect(parseAppServerRequest({
      version: APP_SERVER_PROTOCOL_VERSION,
      id: 'request-1',
      method: 'initialize',
      params: {},
    })).toMatchObject({ id: 'request-1', method: 'initialize' });

    expect(() => parseAppServerRequest({
      version: 2,
      id: 'request-2',
      method: 'initialize',
    })).toThrow('Invalid app-server request');
    expect(() => parseAppServerRequest({
      version: 1,
      id: 'request-3',
      method: 'initialize',
      params: [],
    })).toThrow('Invalid app-server request');
  });
});
