import { Global, Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { FeatureGateService } from './feature-gate.service';
import { SubscriptionsService } from './subscriptions.service';

@Global()
@Module({
  controllers: [BillingController],
  providers: [SubscriptionsService, FeatureGateService],
  exports: [SubscriptionsService, FeatureGateService],
})
export class BillingModule {}
