import { describe, expect, it, vi } from 'vitest';

import { RuntimeServices } from '../src/runtime-v2/services.js';

describe('RuntimeServices', () => {
  it('does not initialize optional services until they are resolved', async () => {
    const memoryFactory = vi.fn(() => ({ close: vi.fn() }));
    const services = new RuntimeServices({
      memory: { factory: memoryFactory, description: 'optional memory' },
    });

    expect(memoryFactory).not.toHaveBeenCalled();
    expect(services.inspect()).toEqual([{
      id: 'memory',
      initialized: false,
      pending: false,
      description: 'optional memory',
    }]);
    await services.close();
    expect(memoryFactory).not.toHaveBeenCalled();
  });

  it('coalesces concurrent initialization and closes initialized services in reverse order', async () => {
    const closed: string[] = [];
    const services = new RuntimeServices({
      sessions: {
        factory: async () => ({ close: () => { closed.push('sessions'); } }),
      },
      memory: {
        factory: async () => ({ close: () => { closed.push('memory'); } }),
      },
    });

    const [left, right] = await Promise.all([
      services.resolve('sessions'),
      services.resolve('sessions'),
    ]);
    expect(left).toBe(right);
    await services.resolve('memory');
    await services.close();
    expect(closed).toEqual(['memory', 'sessions']);
  });

  it('does not cache a failed initialization attempt', async () => {
    let attempts = 0;
    const services = new RuntimeServices({
      tracing: {
        factory: () => {
          attempts += 1;
          if (attempts === 1) throw new Error('temporary failure');
          return {};
        },
      },
    });

    await expect(services.resolve('tracing')).rejects.toThrow('temporary failure');
    await expect(services.resolve('tracing')).resolves.toEqual({});
    expect(attempts).toBe(2);
    await services.close();
  });
});
