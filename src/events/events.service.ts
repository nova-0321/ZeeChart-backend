import { BadRequestException, Injectable } from '@nestjs/common';
import { RequestTransaction } from '../database/request-transaction.js';
import { rejectNulls } from '../common/reject-nulls.js';
import { ProjectsService } from '../projects/projects.service.js';
import type { CreateEventDto } from './dto/create-event.dto.js';
import type { UpdateEventDto } from './dto/update-event.dto.js';
import { ProjectEvent } from './entities/project-event.entity.js';
import { notFound } from '../common/not-found.js';
import { placeEvents } from './event-placing.js';
import { eventRowsOf, lineUpEvents } from './event-rows.js';

const day = (date: string) => String(date).slice(0, 10);

@Injectable()
export class EventsService {
  constructor(
    private readonly tx: RequestTransaction,
    private readonly projects: ProjectsService,
  ) {}

  private get eventRepo() {
    return this.tx.repo(ProjectEvent);
  }

  /** The project's events, the earliest first. */
  findByProject(projectId: string) {
    return this.eventRepo.find({
      where: { projectId },
      order: { startDate: 'ASC', createdAt: 'ASC' },
    });
  }

  /**
   * A new event never shares a day with another (#84): on a taken day it goes after the event
   * there (and on, until it is free), keeping its length. The answer has the dates it got.
   */
  async create(dto: CreateEventDto) {
    this.assertOrdered(dto.startDate, dto.endDate);
    // The foreign key would reject a missing project too, but only with a vague 409.
    if (!(await this.projects.exists(dto.projectId))) {
      throw notFound('Project');
    }
    const asked = { id: '', startDate: day(dto.startDate), endDate: day(dto.endDate) };
    const [placed] = placeEvents(await eventRowsOf(this.tx.manager, dto.projectId), [asked]);
    const { startDate, endDate } = placed ?? asked;
    return this.eventRepo.save(this.eventRepo.create({ ...dto, startDate, endDate }));
  }

  // For restoring an event from its history (revisions), which reads and writes events here (#55).

  /** Whether the event is there. */
  exists(id: string): Promise<boolean> {
    return this.eventRepo.existsBy({ id });
  }

  /**
   * A deleted event made again with its own id (so its history goes on), on its own dates: the
   * events there now move after it, as for a move (#84).
   */
  async recreate(
    id: string,
    projectId: string,
    fields: Pick<ProjectEvent, 'name' | 'color' | 'startDate' | 'endDate'>,
  ): Promise<ProjectEvent> {
    const event = await this.eventRepo.save(this.eventRepo.create({ id, projectId, ...fields }));
    await lineUpEvents(this.tx.manager, projectId, new Set([id]));
    return event;
  }

  /**
   * The dates are checked together, so moving only one end can't invert the range. A moved or
   * resized event keeps its new dates; the events it now shares a day with move after it, and the
   * ones after those if they then do (#84), in this write.
   */
  async update(id: string, dto: UpdateEventDto) {
    rejectNulls(dto, ['description']);
    const event = await this.eventRepo.findOneByOrFail({ id });
    Object.assign(event, dto);
    event.startDate = day(event.startDate);
    event.endDate = day(event.endDate);
    this.assertOrdered(event.startDate, event.endDate);
    const saved = await this.eventRepo.save(event);
    if (dto.startDate !== undefined || dto.endDate !== undefined) {
      await lineUpEvents(this.tx.manager, saved.projectId, new Set([id]));
    }
    return saved;
  }

  async remove(id: string) {
    const event = await this.eventRepo.findOneByOrFail({ id });
    await this.eventRepo.remove(event);
  }

  private assertOrdered(startDate: string, endDate: string) {
    if (day(endDate) < day(startDate)) {
      throw new BadRequestException('The end date must not be before the start date');
    }
  }
}
