import { PartialType } from '@nestjs/swagger';
import { CreateProjectDto } from './create-project.dto.js';
import { IsBoolean, IsOptional } from 'class-validator';

// The id comes from the URL; every field of CreateProjectDto is optional here.
export class UpdateProjectDto extends PartialType(CreateProjectDto) {
  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}
