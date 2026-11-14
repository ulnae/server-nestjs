import { Controller, Get, Post, Body, Patch, Param, Delete, Req, UseGuards } from '@nestjs/common';
import { FriendService } from './friend.service';
import { CreateFriendDto } from './dto/create-friend.dto';
import { UpdateFriendDto } from './dto/update-friend.dto';
import { JwtAuthGuard } from '@/modules/auth/auth.guard';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('好友管理')
@Controller('friend')
@ApiBearerAuth('Authorization')
@UseGuards(JwtAuthGuard)
export class FriendController {
  constructor(private readonly friendService: FriendService) {}

  @ApiOperation({
    summary: '创建记录',
  })
  @Post()
  create(@Body() createFriendDto: CreateFriendDto, @Req() req) {
    return this.friendService.create(createFriendDto, req.user.id);
  }

  @ApiOperation({
    summary: '获取所有记录',
  })
  @Get()
  findAll( @Req() req) {
    return this.friendService.findAll(req.user.id);
  }

  @ApiOperation({
    summary: '删除记录',
  })
  @Delete(':id')
  remove(@Param('id') id: string,  @Req() req) {
    return this.friendService.remove(id, req.user.id);
  }
}
