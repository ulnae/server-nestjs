import { Injectable } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { CreateMemberDto } from '@/modules/member/dto/create-member.dto';
import { SearchMemberDto } from '@/modules/member/dto/search-member.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { MemberEntity } from '@/modules/member/entities/member.entity';
import { RoomEntity } from '@/modules/room/entities/room.entity';
import { UserEntity } from '@/modules/user/entities/user.entity';
import { Repository } from 'typeorm';
import { SocketGateway } from '@/socket/socket.gateway';
import { Event } from '@/socket/events';

@Injectable()
export class MemberService {
  constructor(private readonly socketGateway: SocketGateway) {}

  @InjectRepository(MemberEntity)
  private memberRepository: Repository<MemberEntity>;

  @InjectRepository(RoomEntity)
  private roomRepository: Repository<RoomEntity>;

  @InjectRepository(UserEntity)
  private userRepository: Repository<UserEntity>;

  async create(createMemberDto: CreateMemberDto, operatorId?: string) {
    const room = await this.roomRepository.findOne({
      where: { id: createMemberDto.room_id, isDeleted: false },
    });
    if (!room) {
      throw new HttpException({ message: '房间不存在', i18nKey: 'error.apply.roomNotFound' }, 404);
    }
    if (!operatorId || room.creator !== operatorId) {
      throw new HttpException({ message: '只有群主可以添加成员', i18nKey: 'error.member.onlyOwnerAdd' }, 403);
    }

    // 幂等：已经在房间里就返回原记录，避免重复插入多行成员
    const existing = await this.memberRepository.findOne({
      where: { room_id: createMemberDto.room_id, user_id: createMemberDto.user_id, isDeleted: false },
    });
    if (existing) return existing;

    const saved = await this.memberRepository.save(createMemberDto);
    const user = await this.userRepository.findOne({ where: { id: createMemberDto.user_id } });

    // 被拉进房间的人要立刻看到房间，并且能收到房间消息
    await this.socketGateway.syncUserRooms(createMemberDto.user_id);
    this.socketGateway.sendToUser(createMemberDto.user_id, Event.ROOM_JOINED, {
      roomId: room.id,
      roomName: room.name,
    });
    this.socketGateway.sendToRoom(
      createMemberDto.room_id,
      Event.MEMBER_JOINED,
      { roomId: createMemberDto.room_id, userId: createMemberDto.user_id, username: user?.username },
      createMemberDto.user_id,
    );
    // 新成员此刻多半在线，补发一次在线名单，避免所有人列表里他显示离线
    await this.socketGateway.pushRoomOnline(createMemberDto.room_id);

    return saved;
  }


  async findAll(query: SearchMemberDto, operatorId: string) {
    const roomId = query?.room_id;
    const userId = query?.user_id;
    if (!roomId && !userId) {
      throw new HttpException({ message: '缺少 room_id 或 user_id', i18nKey: 'error.member.requireUserRoom' }, 400);
    }
    // 群成员名单只对群成员开放，否则任何登录用户都能按 id 批量拉别人的成员表
    if (roomId) {
      const mine = await this.memberRepository.findOne({
        where: { room_id: roomId, user_id: operatorId, isDeleted: false },
      });
      if (!mine) throw new HttpException({ message: '你不是该房间成员', i18nKey: 'error.room.notMember' }, 403);
    } else if (userId !== operatorId) {
      throw new HttpException({ message: '只能查询自己的成员关系', i18nKey: 'error.member.onlySelfQuery' }, 403);
    }

    const where: any = { isDeleted: false };
    if (roomId) where.room_id = roomId;
    if (userId) where.user_id = userId;
    return this.memberRepository.find({
      where,
      order: { createdAt: 'DESC' },
      relations: ['room_info', 'user_info'],
      select: {
        id: true,
        room_id: true,
        user_id: true,
        createdAt: true,
        user_info: {
          id: true,
          username: true
        },
        room_info: {
          id: true,
          name: true,
          // 前端房间列表/聊天页的房间信息来自这里，必须带出描述
          description: true,
          createdAt: true,
          updatedAt: true,
          creator: true
        },
      },
    });
  }


  async remove(id: string, operatorId?: string) {
    const member = await this.memberRepository.findOne({
      where: {
        id,
        isDeleted: false,
      },
      relations: ['room_info'],
    });
    if (!member) {
      throw new HttpException({ message: '该成员不存在', i18nKey: 'error.member.notFound' }, 404);
    }

    const isSelf = !!operatorId && member.user_id === operatorId;
    const isOwner = !!operatorId && member.room_info?.creator === operatorId;
    if (!operatorId || (!isSelf && !isOwner)) {
      throw new HttpException({ message: '只有群主可以移出成员', i18nKey: 'error.member.onlyOwnerRemove' }, 403);
    }

    // M-2：群主不能以「退出房间」的方式离开。否则会留下「已不在成员表、但 room.creator
    // 仍是他」的幽灵管理员——收不到房间消息、却仍能改名/解散，房间也无人能正常接管。
    // 群主要离开必须先解散房间（前端群主按钮本就是「解散房间」，这里防直接调 API）。
    if (isSelf && isOwner) {
      throw new HttpException({ message: '群主不能直接退出房间，请先解散房间', i18nKey: 'error.member.ownerCannotLeave' }, 409);
    }

    member.isDeleted = true;
    const saved = await this.memberRepository.save(member);

    const roomId = member.room_id;
    const roomName = member.room_info?.name || '';
    const operator = operatorId
      ? await this.userRepository.findOne({ where: { id: operatorId } })
      : null;

    if (isSelf) {
      // 主动退出：给自己回执并摘掉房间订阅
      this.socketGateway.sendToUser(member.user_id, Event.ROOM_LEFT, { roomId, roomName });
      await this.socketGateway.syncUserRooms(member.user_id);
    } else {
      // 被踢：先通知原因，再摘掉房间订阅
      this.socketGateway.sendToUser(member.user_id, Event.ROOM_KICKED, {
        roomId,
        roomName,
        byUserId: operatorId,
        byUsername: operator?.username,
      });
      await this.socketGateway.syncUserRooms(member.user_id);
    }

    // 房间里的其他人：成员列表要减一
    this.socketGateway.sendToRoom(
      roomId,
      Event.MEMBER_REMOVED,
      {
        roomId,
        userId: member.user_id,
        byUserId: operatorId,
        byUsername: operator?.username,
        reason: isSelf ? 'left' : 'kicked',
      },
      member.user_id,
    );

    // 退出 / 被踢后房间在线集合变了，补发一次在线名单。
    // 否则其余成员的房间列表在线人数停留在旧值（分子没减、分母已减）。
    await this.socketGateway.pushRoomOnline(roomId);

    return saved;
  }
}
