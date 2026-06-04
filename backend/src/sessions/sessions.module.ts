import { Module } from '@nestjs/common';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { TestsModule } from '../tests/tests.module';
import { PushModule } from '../push/push.module';

@Module({
  imports: [TestsModule, PushModule],
  controllers: [SessionsController],
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
