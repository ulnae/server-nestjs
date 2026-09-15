import { Controller, Post, HttpCode, Body } from '@nestjs/common';
import { SocketGateway } from '@/socket/socket.gateway';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('系统通知')
@Controller('alert')
@ApiBearerAuth('Authorization')
export class AlertController {
    constructor(private socketGateway: SocketGateway) { }


    @ApiOperation({
        summary: '全用户通知',
    })
    @Post()
    @HttpCode(200)
    sendAlert(@Body() dto: { message: string, sender: string }) {
        this.socketGateway.wss.emit('system:alert', {
            sender: dto.sender ||'系统通知',
            message: dto.message,
            timestamp: Date.now()
        });
        return 'Alert successfully';
    }
}
