import { Module } from '@nestjs/common';
import { RtcController } from '@/modules/rtc/rtc.controller';
import { RtcService } from '@/modules/rtc/rtc.service';

@Module({
  imports: [],
  controllers: [RtcController],
  providers: [RtcService],
})
export class RtcModule {}
