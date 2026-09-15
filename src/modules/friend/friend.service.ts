import { Injectable } from '@nestjs/common';
import { CreateFriendDto } from './dto/create-friend.dto';
import { UpdateFriendDto } from './dto/update-friend.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FriendEntity } from './entities/friend.entity';
import { HttpException } from '@nestjs/common';

@Injectable()
export class FriendService {
  constructor(
    @InjectRepository(FriendEntity)
    private friendRepository: Repository<FriendEntity>,
  ) {}

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
    return this.friendRepository.save(createFriendDto);
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
      },
    });

    if (!friend) {
      throw new HttpException('好友关系不存在',401);
    }

    return this.friendRepository.update(friend.id, {
      isDeleted: true,
    });
  }
}
