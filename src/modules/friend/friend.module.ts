import { Module } from '@nestjs/common';
import { FriendService } from './friend.service';
import { FriendController } from './friend.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FriendEntity } from './entities/friend.entity';
import { UserEntity } from '@/modules/user/entities/user.entity';
import { SocketModule } from '@/socket/socket.module';

@Module({
  imports: [TypeOrmModule.forFeature([FriendEntity, UserEntity]), SocketModule], // 关联数据库
  controllers: [FriendController],
  providers: [FriendService],
  exports: [TypeOrmModule],
})
export class FriendModule {}
