import { Controller, Get, Post, Body, Param, Delete, Req, UseGuards } from '@nestjs/common';
import { MemberService } from '@/modules/member/member.service';
import { CreateMemberDto } from '@/modules/member/dto/create-member.dto';
import { SearchMemberDto } from '@/modules/member/dto/search-member.dto';
import { JwtAuthGuard } from '@/modules/auth/auth.guard';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('房间成员')
@Controller('member')
@ApiBearerAuth('Authorization')
@UseGuards(JwtAuthGuard)
export class MemberController {
  constructor(private readonly memberService: MemberService) { }

  @ApiOperation({
    summary: '创建成员',
  })
  @Post()
  create(@Body() createMemberDto: CreateMemberDto, @Req() req) {
    return this.memberService.create(createMemberDto, req.user?.id);
  }

  @ApiOperation({
    summary: '查询全部成员',
  })
  @Get()
  findAll(@Req() req: Request & { query: SearchMemberDto; user: any }) {
    return this.memberService.findAll(req.query, req.user?.id);
  }


  @ApiOperation({
    summary: '删除成员',
  })
  @Delete(':id')
  remove(@Param('id') id: string, @Req() req) {
    return this.memberService.remove(id, req.user?.id);
  }
}
