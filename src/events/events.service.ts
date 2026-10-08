import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Project } from '../projects/entities/project.entity.js';
import type { CreateEventDto } from './dto/create-event.dto.js';
import type { UpdateEventDto } from './dto/update-event.dto.js';
import { ProjectEvent } from './entities/project-event.entity.js';

const day = (date: string) => String(date).slice(0, 10);

@Injectable()
export class EventsService {
  constructor(
    @InjectRepository(ProjectEvent)
    private readonly eventRepo: Repository<ProjectEvent>,
  ) {}

  /** The project's events, the earliest first. */
  findByProject(projectId: string) {
    return this.eventRepo.find({
      where: { projectId },
      order: { startDate: 'ASC', createdAt: 'ASC' },
    });
  }

  async create(dto: CreateEventDto) {
    this.assertOrdered(dto.startDate, dto.endDate);
    // The foreign key would reject a missing project too, but only with a vague 409.
    const projectExists = await this.eventRepo.manager.exists(Project, {
      where: { id: dto.projectId },
    });
    if (!projectExists) throw new NotFoundException('Project not found');
    return this.eventRepo.save(
      this.eventRepo.create({ ...dto, startDate: day(dto.startDate), endDate: day(dto.endDate) }),
    );
  }

  /** The dates are checked together, so moving only one end can't invert the range. */
  async update(id: string, dto: UpdateEventDto) {
    const event = await this.eventRepo.findOneByOrFail({ id });
    Object.assign(event, dto);
    event.startDate = day(event.startDate);
    event.endDate = day(event.endDate);
    this.assertOrdered(event.startDate, event.endDate);
    return this.eventRepo.save(event);
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
