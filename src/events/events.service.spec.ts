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
  };
  /** ProjectsService: events ask it whether their project exists. */
  const projects = { exists: vi.fn() };
  /** The project's events as stored (read to place one, #84), and the pushes written. */
  let projectEvents: {
    id: string;
    name: string;
    color: string;
    startDate: string;
    endDate: string;
  }[];
  const query = vi.fn();
  let service: EventsService;

  beforeEach(() => {
    vi.resetAllMocks();
    repo.create.mockImplementation((values: object) => values);
    repo.save.mockImplementation((value: object) => Promise.resolve({ id: 'e1', ...value }));
    projects.exists.mockResolvedValue(true);
    projectEvents = [];
    query.mockImplementation((sql: string) =>
      Promise.resolve(sql.trimStart().startsWith('SELECT') ? projectEvents : []),
    );
    service = new EventsService(
      { repo: () => repo, manager: { query } } as never,
      projects as never,
    );
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

  it('places a new event on a taken day after the event there, keeping its length (#84)', async () => {
    projectEvents = [
      { id: 'a', name: 'Launch', color: '#000000', startDate: '2026-10-10', endDate: '2026-10-20' },
    ];
    await service.create(body({ startDate: '2026-10-15', endDate: '2026-10-18' }) as never);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: '2026-10-21', endDate: '2026-10-24' }),
    );
    // The others are not moved by a create.
    expect(query).toHaveBeenCalledTimes(1);
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
    projects.exists.mockResolvedValue(false);
    await expect(service.create(body() as never)).rejects.toBeInstanceOf(NotFoundException);
    // Asked of the projects domain, not read from its table.
    expect(projects.exists).toHaveBeenCalledWith(PROJECT);
    expect(repo.save).not.toHaveBeenCalled();
  });

  const currentEvents = (rows: typeof projectEvents) => {
    projectEvents = rows;
  };

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

    it('pushes the events a move now overlaps, keeping the moved one where it was put (#84)', async () => {
      repo.findOneByOrFail.mockResolvedValue({ ...stored(), projectId: PROJECT });
      const moved = {
        id: 'e1',
        name: 'Old',
        color: '#e5484d',
        startDate: '2026-10-20',
        endDate: '2026-10-22',
      };
      const d = {
        id: 'd',
        name: 'D',
        color: '#000000',
        startDate: '2026-10-21',
        endDate: '2026-10-23',
      };
      // As read after the save.
      currentEvents([moved, d]);
      await service.update('e1', { startDate: '2026-10-20', endDate: '2026-10-22' });
      const update = query.mock.calls.find(([sql]) => String(sql).includes('UPDATE'));
      expect(update?.[1]).toEqual([['d'], ['2026-10-23'], ['2026-10-25']]);
    });

    it('reads and moves nothing when no date changed', async () => {
      repo.findOneByOrFail.mockResolvedValue({ ...stored(), projectId: PROJECT });
      await service.update('e1', { name: 'New' });
      expect(query).not.toHaveBeenCalled();
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
