import { Injectable } from '@nestjs/common';
import { CreateFriendDto } from './dto/create-friend.dto';
import { UpdateFriendDto } from './dto/update-friend.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FriendEntity } from './entities/friend.entity';
import { UserEntity } from '@/modules/user/entities/user.entity';
import { HttpException } from '@nestjs/common';
import { SocketGateway } from '@/socket/socket.gateway';
import { Event } from '@/socket/events';

@Injectable()
export class FriendService {
  constructor(private readonly socketGateway: SocketGateway) {}

  @InjectRepository(FriendEntity)
  private friendRepository: Repository<FriendEntity>;

  @InjectRepository(UserEntity)
  private userRepository: Repository<UserEntity>;

  async create(createFriendDto: CreateFriendDto, operatorId: string) {
    // creator 只能取当前登录用户：以前直接用 body 里的值，等于允许任何人伪造「别人加了你」
    const creator = operatorId;
    const friendId = createFriendDto.friend_id;
    if (!friendId) throw new HttpException('缺少 friend_id', 400);
    if (friendId === creator) throw new HttpException('不能添加自己为好友', 400);

    const target = await this.userRepository.findOne({ where: { id: friendId, isDeleted: false } });
    if (!target) throw new HttpException('该用户不存在', 404);

    // 检查好友是否存在
    const friend = await this.friendRepository.findOne({
      where: { isDeleted: false, creator, friend_id: friendId },
    });

    if (friend) {
      throw new HttpException('好友关系已存在', 409);
    }

    // 创建好友关系
    const saved = await this.friendRepository.save({ creator, friend_id: friendId });

    // 对方也要立刻看到这条好友关系
    const me = await this.userRepository.findOne({ where: { id: creator } });
    this.socketGateway.sendToUser(friendId, Event.FRIEND_ADDED, {
      userId: creator,
      username: me?.username,
    });
    // 补发双向在线状态：双方列表刚出现对方，可能此刻就在线
    await this.socketGateway.pushUserStatus(creator);
    return saved;
  }

  findAll(creator: string) {
    return this.friendRepository.find({
      where: {
        creator,
        isDeleted: false,
      },
      relations: ['friend_info', 'user_info'],
      select: {
        id: true,
        friend_id: true,
        friend_info: {
          id: true,
          username: true,
          email: true,
          createdAt: true,
        },
        createdAt: true,
        creator: true,
        user_info: {
          id: true,
          username: true,
          email: true,
          createdAt: true,
        },
      }
    });
  }



  async remove(friend_id: string, creator: string) {
    const friend = await this.friendRepository.findOne({
      where: {
        friend_id,
        creator,
        isDeleted: false,
      },
    });

    if (!friend) {
      // 自己那侧没有记录时，允许清理对方残留的单向记录
      const reverse = await this.friendRepository.findOne({
        where: { creator: friend_id, friend_id: creator, isDeleted: false },
      });
      if (!reverse) {
        throw new HttpException('好友关系不存在', 404);
      }
    }

    // 双向软删：否则对方列表里会留下一个「幽灵好友」
    await this.friendRepository.update({ creator, friend_id }, { isDeleted: true });
    await this.friendRepository.update({ creator: friend_id, friend_id: creator }, { isDeleted: true });

    const me = await this.userRepository.findOne({ where: { id: creator } });
    this.socketGateway.sendToUser(friend_id, Event.FRIEND_REMOVED, {
      userId: creator,
      username: me?.username,
    });
    return { affected: 1 };
  }
}
