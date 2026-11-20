import { Controller, Get, Post, Body, Patch, Param, Delete, Req, UseGuards } from '@nestjs/common';
import { ApplyService } from '@/modules/apply/apply.service';
import { CreateApplyDto } from '@/modules/apply/dto/create-apply.dto';
import { UpdateApplyDto } from '@/modules/apply/dto/update-apply.dto';
import { JwtAuthGuard } from '@/modules/auth/auth.guard';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('用户申请')
@Controller('apply')
@ApiBearerAuth('Authorization')
@UseGuards(JwtAuthGuard)
export class ApplyController {
  constructor(private readonly applyService: ApplyService) { }

  @ApiOperation({
    summary: '创建申请',
  })
  @Post()
  create(@Body() createApplyDto: CreateApplyDto, @Req() req) {
    return this.applyService.create(createApplyDto, req.user.id);
  }

  @ApiOperation({
    summary: '查询我的所有申请',
  })
  @Get()
  findAll(@Req() req) {
    return this.applyService.findAll(req.user.id);
  }

  @ApiOperation({
    summary: '查询待我审批的申请（好友 + 入群统一）',
  })
  @Get('mine')
  findApplyAll(@Req() req) {
    return this.applyService.findApplyAll(req.user.id);
  }


  @ApiOperation({
    summary: '修改申请状态',
  })
  @Patch(':id')
  update(@Param('id') id: string, @Body() updateApplyDto: UpdateApplyDto, @Req() req) {
    return this.applyService.update(id, {
      status: updateApplyDto.status,
      handle_status: true,
    }, req.user.id);
  }

  @ApiOperation({
    summary: '删除申请记录',
  })
  @Delete(':id')
  remove(@Param('id') id: string, @Req() req) {
    return this.applyService.remove(id, req.user.id);
  }
}
