import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EventsService } from './events.service.js';

const PROJECT = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

const body = (extra: object = {}) => ({
  name: 'Freeze',
  color: '#e5484d',
  startDate: '2026-10-05',
  endDate: '2026-10-12',
  projectId: PROJECT,
  ...extra,
});

describe('EventsService', () => {
  const repo = {
    find: vi.fn(),
    create: vi.fn(),
    save: vi.fn(),
    remove: vi.fn(),
    findOneByOrFail: vi.fn(),
    manager: { exists: vi.fn() },
  };
  let service: EventsService;

  beforeEach(() => {
    vi.resetAllMocks();
    repo.create.mockImplementation((values: object) => values);
    repo.save.mockImplementation((value: object) => Promise.resolve({ id: 'e1', ...value }));
    repo.manager.exists.mockResolvedValue(true);
    service = new EventsService({ repo: () => repo } as never);
  });

  it('lists the earliest events first', async () => {
    await service.findByProject(PROJECT);
    expect(repo.find).toHaveBeenCalledWith({
      where: { projectId: PROJECT },
      order: { startDate: 'ASC', createdAt: 'ASC' },
    });
  });

  it('creates an event of a project, keeping only the day of the dates', async () => {
    await service.create(body({ startDate: '2026-10-05T10:00:00Z' }) as never);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Freeze', startDate: '2026-10-05', endDate: '2026-10-12' }),
    );
  });

  it('accepts a one-day event', async () => {
    await expect(
      service.create(body({ startDate: '2026-10-05', endDate: '2026-10-05' }) as never),
    ).resolves.toBeDefined();
  });

  it('rejects an end date before the start date and saves nothing', async () => {
    await expect(service.create(body({ endDate: '2026-10-01' }) as never)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(repo.save).not.toHaveBeenCalled();
  });

  it('answers 404 for a project that does not exist, and saves nothing', async () => {
    repo.manager.exists.mockResolvedValue(false);
    await expect(service.create(body() as never)).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.save).not.toHaveBeenCalled();
  });

  describe('update', () => {
    const stored = () => ({
      id: 'e1',
      name: 'Old',
      color: '#e5484d',
      startDate: '2026-10-05',
      endDate: '2026-10-12',
    });

    it('changes only the fields that were sent', async () => {
      repo.findOneByOrFail.mockResolvedValue(stored());
      await expect(service.update('e1', { name: 'New' })).resolves.toMatchObject({
        name: 'New',
        startDate: '2026-10-05',
      });
    });

    it('rejects moving only the end before the stored start, and saves nothing', async () => {
      repo.findOneByOrFail.mockResolvedValue(stored());
      await expect(service.update('e1', { endDate: '2026-10-01' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('passes on the not-found error for an unknown event', async () => {
      repo.findOneByOrFail.mockRejectedValue(new NotFoundException());
      await expect(service.update('nope', { name: 'x' })).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('removes an event', async () => {
    const event = { id: 'e1' };
    repo.findOneByOrFail.mockResolvedValue(event);
    await service.remove('e1');
    expect(repo.remove).toHaveBeenCalledWith(event);
  });
});
