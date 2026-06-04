import { Module } from '@nestjs/common';
import { PushModule } from '../push/push.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * In-app notification feed. The write side lives in PushService (every push is
 * mirrored to a Notification row); this module owns the read/manage API + the
 * admin broadcast. Imports PushModule so the broadcast can fan out web-push.
 */
@Module({
  imports: [PushModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
