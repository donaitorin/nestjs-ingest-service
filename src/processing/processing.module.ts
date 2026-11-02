import { Module } from '@nestjs/common';
import { EventsModule } from '../events/events.module';
import { ExternalSystemClient } from './external-system.client';
import { PatientProcessor } from './patient-processor';
import { PatientsRepository } from './patients.repository';
import { ReaperService } from './reaper.service';
import { WorkerService } from './worker.service';

@Module({
  imports: [EventsModule],
  providers: [PatientsRepository, ExternalSystemClient, PatientProcessor, WorkerService, ReaperService],
})
export class ProcessingModule {}
