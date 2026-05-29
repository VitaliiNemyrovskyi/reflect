import { Module } from '@nestjs/common';
import { PushController } from './push.controller';
import { PushService } from './push.service';
import { PushReminderScheduler } from './push-reminder.scheduler';

/**
 * Web Push: subscription management (controller), sending (service), and the
 * daily care-loop reminder (scheduler). ScheduleModule is registered globally
 * at the app root (shared by the city + diary crons), so @Cron here wires in
 * automatically. Service is exported in case other modules need to notify.
 */
@Module({
  controllers: [PushController],
  providers: [PushService, PushReminderScheduler],
  exports: [PushService],
})
export class PushModule {}
