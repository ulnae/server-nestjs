import { Controller, Get, Post, Body, Patch, Param, Delete, Query, UseGuards, Req } from '@nestjs/common';
import { RoomService } from '@/modules/room/room.service';
import { CreateRoomDto } from '@/modules/room/dto/create-room.dto';
import { UpdateRoomDto } from '@/modules/room/dto/update-room.dto';
import { JwtAuthGuard } from '@/modules/auth/auth.guard';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('房间管理')
@Controller('room')
@ApiBearerAuth('Authorization')
@UseGuards(JwtAuthGuard)
export class RoomController {
  constructor(private readonly roomService: RoomService) { }

  @ApiOperation({
    summary: '创建房间',
  })
  @Post()
  create(@Body() createRoomDto: CreateRoomDto, @Req() request) {
    return this.roomService.create(createRoomDto, request.user);
  }

  @ApiOperation({
    summary: '查询全部房间列表',
  })
  @Get()
  findAll(@Query('page') page: number = 1, @Query('pageSize') pageSize: number = 10) {
    return this.roomService.findAll(page, pageSize);
  }

  @ApiOperation({
    summary: '搜索房间',
  })
  @Get('/search')
  searchAll(@Query('name') name: string) {
    return this.roomService.searchAll(name);
  }

  @ApiOperation({
    summary: '登录聚合拉取：我加入的房间 + 每房成员 + 每房在线名单',
  })
  @Get('/overview')
  overview(@Req() request) {
    return this.roomService.overview(request.user);
  }

  @ApiOperation({
    summary: '通过id查询房间',
  })
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.roomService.findOne(id);
  }

  @ApiOperation({
    summary: '通过id更新房间',
  })
  @Patch(':id')
  update(@Param('id') id: string, @Body() updateRoomDto: UpdateRoomDto, @Req() request) {
    return this.roomService.update(id, updateRoomDto, request.user?.id);
  }

  @ApiOperation({
    summary: '通过id删除房间',
  })
  @Delete(':id')
  remove(@Param('id') id: string, @Req() request) {
    return this.roomService.remove(id, request.user?.id);
  }
}
