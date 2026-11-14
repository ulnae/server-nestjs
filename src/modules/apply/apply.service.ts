import { Injectable } from '@nestjs/common';
import { CreateApplyDto } from '@/modules/apply/dto/create-apply.dto';
import { UpdateApplyDto } from '@/modules/apply/dto/update-apply.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { ApplyEntity } from '@/modules/apply/entities/apply.entity';
import { Repository } from 'typeorm';
import { HttpException } from '@nestjs/common';
import { FriendEntity } from '@/modules/friend/entities/friend.entity';
import { MemberEntity } from '@/modules/member/entities/member.entity';
import { RoomEntity } from '@/modules/room/entities/room.entity';
import { SocketGateway } from '@/socket/socket.gateway';
import { Event } from '@/socket/events';

@Injectable()
export class ApplyService {
  constructor(private readonly socketGateway: SocketGateway) {}

  // 申请服务
  @InjectRepository(ApplyEntity)
  private applyRepository: Repository<ApplyEntity>
  // 好友服务
  @InjectRepository(FriendEntity)
  private friendRepository: Repository<FriendEntity>
  // 房间成员服务
  @InjectRepository(MemberEntity)
  private memberRepository: Repository<MemberEntity>
  // 房间服务（用于取房主做实时通知）
  @InjectRepository(RoomEntity)
  private roomRepository: Repository<RoomEntity>

  async create(createApplyDto: CreateApplyDto, user_id: string) {
    // let 
    const apply = await this.applyRepository.findOne({
      where: Object.assign(createApplyDto, { user_id, isDeleted: false, handle_status: false }),
    })
    if (apply) {
      throw new HttpException('已存在相同申请', 409);
    }
    const saved = await this.applyRepository.save(Object.assign(createApplyDto, { user_id }));

    // 实时通知接收方：好友申请发给被申请人，入群申请发给房主
    const detail = await this.applyRepository.findOne({
      where: { id: saved.id },
      relations: ['user_info', 'room_info', 'apply_user_info'],
    });
    if (createApplyDto.apply_user_id) {
      this.socketGateway.sendToUser(createApplyDto.apply_user_id, Event.FRIEND_REQUEST, { apply: detail });
    } else if (createApplyDto.room_id) {
      const room = await this.roomRepository.findOne({ where: { id: createApplyDto.room_id, isDeleted: false } });
      if (room) {
        this.socketGateway.sendToUser(room.creator, Event.ROOM_APPLY, {
          apply: detail,
          roomId: room.id,
          roomName: room.name,
        });
      }
    }
    return saved;
  }

  findAll(user_id: string) {
    return this.applyRepository.find({
      where: { user_id, isDeleted: false }, 
      order: { createdAt: 'DESC' },
      relations: ['user_info', 'room_info', 'apply_user_info'],
      select: {
        id: true,
        user_id: true,
        room_id: true,
        apply_user_id: true,
        status: true,
        createdAt: true,
        handle_status: true,
        updatedAt: true,
        user_info: {
          id: true,
          username: true,
          email: true,
        },
        room_info: {
          id: true,
          name: true,
          description: true,
        },
        apply_user_info: {
          id: true,
          username: true,
          email: true,
        },
      }
    });
  }

  findRoomAll(room_id: string) {
    return this.applyRepository.find({
      where: { room_id, isDeleted: false, handle_status: false }, 
      order: { createdAt: 'DESC' },
      relations: ['user_info', 'room_info', 'apply_user_info'],
      select: {
        id: true,
        user_id: true,
        room_id: true,
        apply_user_id: true,
        status: true,
        createdAt: true,
        handle_status: true,
        updatedAt: true,
        user_info: {
          id: true,
          username: true,
          email: true,
        },
        room_info: {
          id: true,
          name: true,
          description: true,
        },
        apply_user_info: {
          id: true,
          username: true,
          email: true,
        },
      }
    });
  }

  findApplyAll(apply_user_id: string) {
    return this.applyRepository.find({
      where: { apply_user_id, isDeleted: false }, 
      order: { createdAt: 'DESC' },
      relations: ['user_info', 'room_info', 'apply_user_info'],
      select: {
        id: true,
        user_id: true,
        room_id: true,
        apply_user_id: true,
        status: true,
        createdAt: true,
        handle_status: true,
        updatedAt: true,
        user_info: {
          id: true,
          username: true,
          email: true,
        },
        room_info: {
          id: true,
          name: true,
          description: true,
        },
        apply_user_info: {
          id: true,
          username: true,
          email: true,
        },
      }
    });
  }

  async update(id: string, updateApplyDto: UpdateApplyDto, userId: string) {
    // 检查是否存在
    const apply = await this.applyRepository.findOne({
      where: { id, isDeleted: false },
      relations: ['user_info', 'room_info', 'apply_user_info'],
    });
    if (!apply) {
      throw new HttpException('申请不存在', 404);
    }
    if (apply.handle_status) {
      throw new HttpException('已处理，不能再操作', 409);
    }

    if (apply.apply_user_id && apply.apply_user_id !== userId) {
      throw new HttpException('不是被申请人，不能操作', 403);
    }
    if (apply.apply_user_id) {
      // todo 申请好友时，判断是否是好友
      if (updateApplyDto.status) {
        // 同意好友申请时，判断是否是好友
        await this.friendRepository.save([
          {
            creator: apply.apply_user_id,
            friend_id: apply.user_id,
          },
          {
            creator: apply.user_id,
            friend_id: apply.apply_user_id,
          },
        ])
      }
    }

    if (apply.room_id && apply.room_info?.creator !== userId) {
      throw new HttpException('不是房间创建人，不能操作', 403);
    }
    if (apply.room_id) {
      // todo 申请加入房间时，判断是否是房间成员
      if (updateApplyDto.status) {
        // 同意加入房间时，判断是否是房间成员
        await this.memberRepository.save({
          room_id: apply.room_id,
          user_id: apply.user_id,
        })
      }
    }

    // 只取这两个字段：DTO 没有 whitelist，直接透传会把 user_id / room_id 一起写进去
    const result = await this.applyRepository.update(id, {
      status: !!updateApplyDto.status,
      handle_status: true,
    });

    // 实时通知申请人处理结果（事件名与 worker 侧一致）
    if (apply.apply_user_id) {
      this.socketGateway.sendToUser(
        apply.user_id,
        updateApplyDto.status ? Event.FRIEND_ACCEPTED : Event.FRIEND_REJECTED,
        {
          applyId: id,
          status: !!updateApplyDto.status,
          userId,
          username: apply.apply_user_info?.username,
        },
      );
      if (updateApplyDto.status) {
        // 双向补发在线状态：双方列表刚出现对方（REST 列表不带在线状态），
        // 不补发的话对方即使在线也会一直显示离线
        await this.socketGateway.pushUserStatus(apply.user_id);
      }
    } else if (apply.room_id && apply.room_info) {
      this.socketGateway.sendToUser(apply.user_id, Event.ROOM_APPLY_RESULT, {
        applyId: id,
        status: !!updateApplyDto.status,
        roomId: apply.room_info.id,
        roomName: apply.room_info.name,
      });
      if (updateApplyDto.status) {
        // 先同步房间订阅，再广播成员变化：保证新成员能收到后续房间消息
        await this.socketGateway.syncUserRooms(apply.user_id);
        this.socketGateway.sendToRoom(
          apply.room_id,
          Event.MEMBER_JOINED,
          { roomId: apply.room_id, userId: apply.user_id, username: apply.user_info?.username },
          apply.user_id,
        );
        // 成员列表刷新后补发一次在线名单：房间所有人（含新成员自己）的在线集合即时更新
        await this.socketGateway.pushRoomOnline(apply.room_id);
      }
    }

    return result;
  }

  async remove(id: string) {
    // 检查是否存在
    const apply = await this.applyRepository.findOne({
      where: { id, isDeleted: false },
      relations: ['room_info'],
    });
    if (!apply) {
      throw new HttpException('申请不存在', 404);
    }
    if (apply.handle_status) {
      throw new HttpException('已处理，不能再操作', 409);
    }
    const saved = await this.applyRepository.save(Object.assign(apply, { isDeleted: true }));

    // 撤回后接收方的待办要立刻消失
    if (apply.apply_user_id) {
      this.socketGateway.sendToUser(apply.apply_user_id, Event.APPLY_REVOKED, {
        applyId: id,
        fromUserId: apply.user_id,
      });
    } else if (apply.room_info) {
      this.socketGateway.sendToUser(apply.room_info.creator, Event.APPLY_REVOKED, {
        applyId: id,
        fromUserId: apply.user_id,
        roomId: apply.room_id,
      });
    }
    return saved;
  }
}
