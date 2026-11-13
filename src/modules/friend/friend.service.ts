import { Injectable } from '@nestjs/common';
import { CreateFriendDto } from './dto/create-friend.dto';
import { UpdateFriendDto } from './dto/update-friend.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FriendEntity } from './entities/friend.entity';
import { UserEntity } from '@/modules/user/entities/user.entity';
import { HttpException } from '@nestjs/common';
import { SocketGateway } from '@/socket/socket.gateway';

@Injectable()
export class FriendService {
  constructor(private readonly socketGateway: SocketGateway) {}

  @InjectRepository(FriendEntity)
  private friendRepository: Repository<FriendEntity>;

  @InjectRepository(UserEntity)
  private userRepository: Repository<UserEntity>;

  async create(createFriendDto: CreateFriendDto) {
    // 检查好友是否存在
    const friend = await this.friendRepository.findOne({
      where: {
        isDeleted: false,
        ...createFriendDto,
      },
    });

    if (friend) {
      throw new HttpException('好友关系已存在',401);
    }

    // 创建好友关系
    const saved = await this.friendRepository.save(createFriendDto);

    // 对方也要立刻看到这条好友关系
    const creator = await this.userRepository.findOne({ where: { id: createFriendDto.creator } });
    this.socketGateway.sendToUser(createFriendDto.friend_id, 'friend:added', {
      user: { id: createFriendDto.creator, username: creator?.username },
    });
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
        throw new HttpException('好友关系不存在', 401);
      }
    }

    // 双向软删：否则对方列表里会留下一个「幽灵好友」
    await this.friendRepository.update({ creator, friend_id }, { isDeleted: true });
    await this.friendRepository.update({ creator: friend_id, friend_id: creator }, { isDeleted: true });

    const me = await this.userRepository.findOne({ where: { id: creator } });
    this.socketGateway.sendToUser(friend_id, 'friend:removed', {
      userId: creator,
      username: me?.username,
    });
    return { affected: 1 };
  }
}
