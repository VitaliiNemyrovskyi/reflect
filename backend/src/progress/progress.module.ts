import { Module } from '@nestjs/common';
import { ProgressService } from './progress.service';
import { ProgressController } from './progress.controller';
import { PushModule } from '../push/push.module';

@Module({
  imports: [PushModule],
  controllers: [ProgressController],
  providers: [ProgressService],
  // Exported so AdminModule can reuse it for the admin therapist board.
  exports: [ProgressService],
})
export class ProgressModule {}
