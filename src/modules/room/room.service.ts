import { Injectable, HttpException } from '@nestjs/common';
import { CreateRoomDto } from '@/modules/room/dto/create-room.dto';
import { UpdateRoomDto } from '@/modules/room/dto/update-room.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Like, Repository } from 'typeorm';
import { RoomEntity } from '@/modules/room/entities/room.entity';
import { UserInfo } from '@/modules/user/user.interface';
import { RoomRo } from '@/modules/room/room.interface';
import { MemberEntity } from '@/modules/member/entities/member.entity';
import { SocketGateway } from '@/socket/socket.gateway';
import { Event } from '@/socket/events';

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

  /**
   * 登录 / 重连后的单次聚合拉取：我加入的房间 + 每房成员 + 每房在线名单。
   * 替代原来的 /room/mine + /member?user_id + 每房一次 /member?room_id（3+N 个请求 → 1 个）。
   */
  async overview(user: UserInfo) {
    const myMembers = await this.memberRepository.find({
      where: { user_id: user.id, isDeleted: false },
      relations: ['room_info'],
      order: { createdAt: 'ASC' },
    });
    const rooms = (myMembers || [])
      .map(item => item.room_info)
      .filter(room => room && !room.isDeleted);
    const roomIds = rooms.map(room => room.id);

    const members: Record<string, any[]> = {};
    const online: Record<string, string[]> = {};

    if (roomIds.length) {
      const allMembers = await this.memberRepository.find({
        where: { room_id: In(roomIds), isDeleted: false },
        relations: ['user_info'],
        select: {
          id: true,
          room_id: true,
          user_id: true,
          createdAt: true,
          user_info: { id: true, username: true },
        },
      });
      for (const member of allMembers || []) {
        (members[member.room_id] = members[member.room_id] || []).push({
          id: member.id,
          user_id: member.user_id,
          user_info: member.user_info
            ? { id: member.user_info.id, username: member.user_info.username }
            : null,
        });
      }
      for (const roomId of roomIds) {
        online[roomId] = await this.socketGateway.roomOnline(roomId);
      }
    }

    return { rooms, members, online };
  }

  async findOne(id: string) {    const room = await this.roomRepository.findOne({
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
      this.socketGateway.sendToRoom(id, Event.ROOM_UPDATED, { room: updated });
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
      this.socketGateway.sendToRoom(room.id, Event.ROOM_DELETED, {
        roomId: room.id,
        roomName,
        byUserId: operatorId,
      });
    }
    return '删除房间成功'
  }
}
