import { Injectable, HttpException } from '@nestjs/common';
import { CreateRoomDto } from '@/modules/room/dto/create-room.dto';
import { UpdateRoomDto } from '@/modules/room/dto/update-room.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Like, Repository } from 'typeorm';
import { RoomEntity } from '@/modules/room/entities/room.entity';
import { UserInfo } from '@/modules/user/user.interface';
import { RoomRo } from '@/modules/room/room.interface';
import { MemberEntity } from '@/modules/member/entities/member.entity';
import { SocketGateway } from '@/socket/socket.gateway';

@Injectable()
export class RoomService {
  constructor(private readonly socketGateway: SocketGateway) {}

  @InjectRepository(RoomEntity)
  private readonly roomRepository: Repository<RoomEntity>;
  @InjectRepository(MemberEntity)
  private readonly memberRepository: Repository<MemberEntity>;

  async create(createRoomDto: CreateRoomDto, user: UserInfo): Promise<string> {
    const room = await this.roomRepository.save(Object.assign(createRoomDto, {
      creator: user.id,
    }));
    await this.memberRepository.save({
      room_id: room.id,
      user_id: user.id,
    });
    // 新房间要立刻进自己的房间订阅，否则紧接着发消息会被房间校验挡下
    await this.socketGateway.syncUserRooms(user.id);
    return '创建房间成功';
  }
  async findMineAll(page: number = 1, pageSize: number = 10, user: UserInfo): Promise<RoomRo> {
    // 从数据库查询所有房间
    const [rows, total] = await this.roomRepository.findAndCount({
      skip: (page - 1) * pageSize, // 分页偏移量
      take: pageSize, // 每页显示的记录数
      where: {
        creator: user.id,
        isDeleted: false,
        // user_info: {
        //   isDeleted: false,
        // }
      },
      order: {
        createdAt: 'ASC',
      },
      select: {
        id: true,
        name: true,
        description: true,
        creator: true,
        user_info: {
          username: true,
          email: true,
          id: true,
          createdAt: true,
          updatedAt: true
        },
        createdAt: true,
        updatedAt: true,
      },
      relations: ['user_info'],

    });
    return {
      rows,
      total,
    };
  }

  async findAll(page: number = 1, pageSize: number = 10): Promise<RoomRo> {
    // 从数据库查询所有房间
    const [rows, total] = await this.roomRepository.findAndCount({
      skip: (page - 1) * pageSize, // 分页偏移量
      take: pageSize, // 每页显示的记录数
      order: {
        createdAt: 'ASC',
      },
      where: {
        isDeleted: false,
        // user_info: {
        //   isDeleted: false,
        // }
      },
      select: {
        id: true,
        name: true,
        description: true,
        creator: true,
        user_info: {
          username: true,
          email: true,
          id: true,
          createdAt: true,
          updatedAt: true
        },
        createdAt: true,
        updatedAt: true,
      },
      relations: ['user_info'],

    });
    return {
      rows,
      total,
    };
  }

  async searchAll(name: string) {
    return this.roomRepository.find({
      where: {
        name: Like(`%${name}%`),
        isDeleted: false,
      },
      order: {
        createdAt: 'ASC',
      },
      select: {
        id: true,
        name: true,
        description: true,
        creator: true,
        user_info: {
          username: true,
          email: true,
          id: true,
          createdAt: true,
          updatedAt: true
        },
        createdAt: true,
        updatedAt: true,
      },
      relations: ['user_info']

    })
  }

  async findOne(id: string) {
    const room = await this.roomRepository.findOne({
      where: { 
        id, 
        isDeleted: false, 
        // user_info: { isDeleted: false } 
      },
      select: {
        id: true,
        name: true,
        description: true,
        creator: true,
        user_info: {
          username: true,
          email: true,
          id: true,
          createdAt: true,
          updatedAt: true
        },
        createdAt: true,
        updatedAt: true,
      },
      relations: ['user_info']
    });
    if (!room) {
      throw new HttpException(`id为${id}的房间不存在`, 401);
    }
    return room;
  }

  async update(id: string, updateRoomDto: UpdateRoomDto, operatorId?: string) {
    const room = await this.roomRepository.findOne({ 
      where: { 
        id, 
        isDeleted: false, 
        // user_info: { isDeleted: false } 
      } 
    });
    if (!room) {
      throw new HttpException(`id为${id}的房间不存在`, 401);
    }
    const updateRoomDtoCopy = { ...updateRoomDto };
    updateRoomDto.name && (updateRoomDtoCopy.name = updateRoomDto.name);
    updateRoomDto.description && (updateRoomDtoCopy.description = updateRoomDto.description);
    const updatePost = this.roomRepository.merge(room, updateRoomDtoCopy);
    await this.roomRepository.save(updatePost);

    // 房间改名等变化要同步给房间内所有人
    const updated = await this.findOne(id);
    if (updated) {
      this.socketGateway.sendToRoom(id, 'room:updated', { room: updated }, operatorId);
    }
    return '更新房间成功'
  }

  async remove(id: string, operatorId?: string) {
    const room = await this.roomRepository.findOne({ 
      where: { 
        id, 
        isDeleted: false, 
        // user_info: { isDeleted: false } 
      } 
    });
    if (!room) {
      throw new HttpException(`id为${id}的房间不存在`, 401);
    }
    if (operatorId && room.creator !== operatorId) {
      throw new HttpException('只有群主可以解散房间', 401);
    }

    const roomName = room.name;
    room.isDeleted = true;
    await this.roomRepository.save(room);
    // 标记所有房间成员为已删除
    await this.memberRepository.update({ room_id: room.id }, { isDeleted: true });

    // 解散房间：所有在线成员立刻收到通知，并把房间从订阅里摘掉
    if (operatorId) {
      this.socketGateway.sendToRoom(room.id, 'room:deleted', {
        roomId: room.id,
        roomName,
        by: { id: operatorId },
      });
    }
    return '删除房间成功'
  }
}
