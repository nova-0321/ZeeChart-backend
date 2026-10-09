import type { RealtimeGateway } from './realtime.gateway.js';
import { RealtimeService } from './realtime.service.js';
import { clientIdFrom, type ChangeMessage } from './realtime.types.js';

const ID = '3f2b8c1e-9a4d-4e5f-8a6b-7c8d9e0f1a2b';
const message: ChangeMessage = { projectId: ID, entity: 'task', action: 'update', id: ID };

describe('clientIdFrom', () => {
  it('takes a UUID (lower-cased) and ignores anything else', () => {
    expect(clientIdFrom(ID)).toBe(ID);
    expect(clientIdFrom(ID.toUpperCase())).toBe(ID);
    for (const junk of [undefined, null, '', 'abc', 42, {}, [ID], `${ID} `]) {
      expect(clientIdFrom(junk)).toBeUndefined();
    }
  });
});

describe('RealtimeService', () => {
  const fakeServer = () => {
    const emit = vi.fn();
    const except = vi.fn(() => ({ emit }));
    const to = vi.fn(() => ({ emit, except }));
    return { server: { to } as never, to, except, emit };
  };

  it('sends to the project room, skipping the sender', () => {
    const { server, to, except, emit } = fakeServer();
    new RealtimeService({ server } as unknown as RealtimeGateway).notify(message, ID);
    expect(to).toHaveBeenCalledWith(`project:${ID}`);
    expect(except).toHaveBeenCalledWith(`client:${ID}`);
    expect(emit).toHaveBeenCalledWith('changed', message);
  });

  it('without a valid sender id it sends to the whole room', () => {
    const { server, except, emit } = fakeServer();
    new RealtimeService({ server } as unknown as RealtimeGateway).notify(message, 'junk');
    expect(except).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('changed', message);
  });

  it('never throws: no socket server, or a failing one', () => {
    expect(() =>
      new RealtimeService({} as unknown as RealtimeGateway).notify(message),
    ).not.toThrow();
    const broken = {
      to: () => {
        throw new Error('boom');
      },
    };
    const service = new RealtimeService({ server: broken } as never);
    vi.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    expect(() => service.notify(message)).not.toThrow();
  });
});
