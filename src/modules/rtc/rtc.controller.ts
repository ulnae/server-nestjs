import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/auth/auth.guard';
import { RtcService } from '@/modules/rtc/rtc.service';

@ApiTags('实时通话')
@Controller('rtc')
@ApiBearerAuth('Authorization')
@UseGuards(JwtAuthGuard)
export class RtcController {
  constructor(private readonly rtcService: RtcService) {}

  @ApiOperation({
    summary: '获取 ICE 配置（含 Cloudflare TURN 短期凭证）',
  })
  @Get('ice')
  iceServers() {
    return this.rtcService.iceServers();
  }
}
