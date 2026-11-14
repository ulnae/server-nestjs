import { Controller, Post, HttpCode, Body, Headers, HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SocketGateway } from '@/socket/socket.gateway';
import { Event } from '@/socket/events';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('系统通知')
@Controller('alert')
export class AlertController {
    constructor(
        private socketGateway: SocketGateway,
        private configService: ConfigService,
    ) { }


    /**
     * 全用户广播。
     *
     * 这是「一人发、全员收」的接口，必须鉴权：之前没有任何守卫，匿名请求就能让全站弹窗。
     * 这里用共享密钥（env.ALERT_SECRET）+ `x-alert-secret` 头；未配置密钥时直接关闭
     * （拒绝优先，而不是默认放行）。
     */
    @ApiOperation({
        summary: '全用户通知（需要 x-alert-secret 头）',
    })
    @Post()
    @HttpCode(200)
    sendAlert(@Body() dto: { message: string, sender?: string }, @Headers('x-alert-secret') secret?: string) {
        const expected = this.configService.get<string>('ALERT_SECRET');
        if (!expected) {
            throw new HttpException('系统广播未启用：请先配置 ALERT_SECRET', 403);
        }
        if (!secret || secret !== expected) {
            throw new HttpException('无权发送系统广播', 403);
        }

        const message = String((dto && dto.message) || '').trim();
        if (!message) throw new HttpException('缺少 message', 400);

        this.socketGateway.wss.emit(Event.SYSTEM_ALERT, {
            senderName: (dto && dto.sender) || '系统通知',
            message,
            timestamp: Date.now()
        });
        return 'Alert successfully';
    }
}
