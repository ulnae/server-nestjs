import { Module } from '@nestjs/common';
import { ApplyService } from '@/modules/apply/apply.service';
import { ApplyController } from '@/modules/apply/apply.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApplyEntity } from '@/modules/apply/entities/apply.entity';
import { RoomEntity } from '@/modules/room/entities/room.entity';
import { UserEntity } from '@/modules/user/entities/user.entity';
import { MemberEntity } from '@/modules/member/entities/member.entity';
import { FriendEntity } from '@/modules/friend/entities/friend.entity';
import { SocketModule } from '@/socket/socket.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([ApplyEntity, RoomEntity, UserEntity, MemberEntity, FriendEntity]),
    SocketModule,
  ], // 关联数据库
  controllers: [ApplyController],
  providers: [ApplyService],
})
export class ApplyModule {}
