import { Module } from '@nestjs/common';
import { CharactersModule } from '../characters/characters.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [CharactersModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
