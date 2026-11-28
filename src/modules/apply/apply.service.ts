import { Injectable } from '@nestjs/common';
import { CreateApplyDto } from '@/modules/apply/dto/create-apply.dto';
import { UpdateApplyDto } from '@/modules/apply/dto/update-apply.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { ApplyEntity } from '@/modules/apply/entities/apply.entity';
import { In, Repository } from 'typeorm';
import { HttpException } from '@nestjs/common';
import { FriendEntity } from '@/modules/friend/entities/friend.entity';
import { MemberEntity } from '@/modules/member/entities/member.entity';
import { RoomEntity } from '@/modules/room/entities/room.entity';
import { UserEntity } from '@/modules/user/entities/user.entity';
import { SocketGateway } from '@/socket/socket.gateway';
import { Event } from '@/socket/events';

/** 申请列表统一返回字段（好友申请 / 入群申请共用） */
const APPLY_SELECT = {
  id: true,
  user_id: true,
  room_id: true,
  apply_user_id: true,
  status: true,
  createdAt: true,
  handle_status: true,
  updatedAt: true,
  user_info: { id: true, username: true, email: true },
  room_info: { id: true, name: true, description: true },
  apply_user_info: { id: true, username: true, email: true },
};

@Injectable()
export class ApplyService {
  constructor(
    private readonly socketGateway: SocketGateway,
    @InjectRepository(UserEntity)
    private userRepository: Repository<UserEntity>,
  ) {}

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
    const roomId = createApplyDto.room_id;
    const applyUserId = createApplyDto.apply_user_id;
    if (!roomId && !applyUserId) {
      throw new HttpException({ message: '缺少 room_id 或 apply_user_id', i18nKey: 'error.apply.requireParams' }, 400);
    }

    // 重复申请去重（注意不要污染 DTO：用新对象组装 where）
    const apply = await this.applyRepository.findOne({
      where: Object.assign({}, createApplyDto, { user_id, isDeleted: false, handle_status: false }),
    })
    if (apply) {
      throw new HttpException({ message: '已存在相同申请', i18nKey: 'error.apply.duplicate' }, 409);
    }

    // H-2：校验目标有效性，与 worker 侧 routes/apply.js create 完全对齐，
    // 避免给自己发好友申请、给不存在的用户/房间发申请、重复加好友/入群产生僵尸待办。
    if (roomId) {
      const room = await this.roomRepository.findOne({ where: { id: roomId, isDeleted: false } });
      if (!room) throw new HttpException({ message: '房间不存在', i18nKey: 'error.apply.roomNotFound' }, 404);
      const alreadyMember = await this.memberRepository.findOne({
        where: { room_id: roomId, user_id, isDeleted: false },
      });
      if (alreadyMember) throw new HttpException({ message: '你已经是该房间成员', i18nKey: 'error.apply.alreadyMember' }, 409);
    }
    if (applyUserId) {
      if (applyUserId === user_id) throw new HttpException({ message: '不能添加自己为好友', i18nKey: 'error.friend.cannotAddSelf' }, 400);
      const target = await this.userRepository.findOne({ where: { id: applyUserId, isDeleted: false } });
      if (!target) throw new HttpException({ message: '该用户不存在', i18nKey: 'error.user.notFound' }, 404);
      const befriended = await this.friendRepository.findOne({
        where: { creator: user_id, friend_id: applyUserId, isDeleted: false },
      });
      if (befriended) throw new HttpException({ message: '你们已经是好友了', i18nKey: 'error.friend.alreadyFriends' }, 409);
    }

    const saved = await this.applyRepository.save(Object.assign({}, createApplyDto, { user_id }));

    // 实时通知接收方：好友申请发给被申请人，入群申请发给房主
    const detail = await this.applyRepository.findOne({
      where: { id: saved.id },
      relations: ['user_info', 'room_info', 'apply_user_info'],
    });
    if (applyUserId) {
      this.socketGateway.sendToUser(applyUserId, Event.FRIEND_REQUEST, { apply: detail });
    } else if (roomId) {
      const room = await this.roomRepository.findOne({ where: { id: roomId, isDeleted: false } });
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

  /** 我发起的申请（好友 + 入群） */
  findAll(user_id: string) {
    return this.applyRepository.find({
      where: { user_id, isDeleted: false },
      order: { createdAt: 'DESC' },
      relations: ['user_info', 'room_info', 'apply_user_info'],
      select: APPLY_SELECT,
    });
  }

  /**
   * 待我审批的申请 —— 好友申请 + 入群申请统一在一个入口返回：
   *   1. 好友申请：apply_user_id = 我（别人申请加我为好友）
   *   2. 入群申请：room_id ∈ 我创建的房间（别人申请加入我的房间，房主视角）
   * 不再需要单独的「按房间查入群申请」接口，申请页一次拉全。
   */
  async findApplyAll(user_id: string) {
    const ownedRooms = await this.roomRepository.find({
      where: { creator: user_id, isDeleted: false },
      select: { id: true },
    });
    const ownedRoomIds = ownedRooms.map((room) => room.id);

    const where: any[] = [{ apply_user_id: user_id, isDeleted: false }];
    if (ownedRoomIds.length) {
      where.push({ room_id: In(ownedRoomIds), isDeleted: false });
    }
    return this.applyRepository.find({
      where,
      order: { createdAt: 'DESC' },
      relations: ['user_info', 'room_info', 'apply_user_info'],
      select: APPLY_SELECT,
    });
  }

  async update(id: string, updateApplyDto: UpdateApplyDto, userId: string) {
    // 检查是否存在
    const apply = await this.applyRepository.findOne({
      where: { id, isDeleted: false },
      relations: ['user_info', 'room_info', 'apply_user_info'],
    });
    if (!apply) {
      throw new HttpException({ message: '申请不存在', i18nKey: 'error.apply.notFound' }, 404);
    }
    if (apply.handle_status) {
      throw new HttpException({ message: '已处理，不能再操作', i18nKey: 'error.apply.alreadyHandled' }, 409);
    }

    // 审批权限校验
    if (apply.apply_user_id && apply.apply_user_id !== userId) {
      throw new HttpException({ message: '不是被申请人，不能操作', i18nKey: 'error.apply.notReceiver' }, 403);
    }
    if (apply.room_id && apply.room_info?.creator !== userId) {
      throw new HttpException({ message: '不是房间创建人，不能操作', i18nKey: 'error.apply.notRoomOwner' }, 403);
    }

    // H-3 + 数据一致性：抢占与关系写入必须在同一个事务里。
    // 两步各自提交时，一旦关系写入失败，就会出现「申请已同意但成员/好友关系不存在」的脏数据
    // （线上 admin 加入吃瓜群即因此房间列表与成员列表同时看不到对方）。
    const status = !!updateApplyDto.status;
    try {
      await this.applyRepository.manager.transaction(async (manager) => {
        // 只更新这两个字段：DTO 无 whitelist，透传会把 user_id / room_id 一起写进去。
        const result = await manager.update(
          ApplyEntity,
          { id, isDeleted: false, handle_status: false },
          { status, handle_status: true },
        );
        if (!result.affected) {
          throw new HttpException({ message: '已处理，不能再操作', i18nKey: 'error.apply.alreadyHandled' }, 409);
        }

        // 抢占成功后才写入关系（事务内先查后写，防重复）
        if (apply.apply_user_id && status) {
          const friendRepo = manager.getRepository(FriendEntity);
          const pairs = [
            { creator: apply.apply_user_id, friend_id: apply.user_id },
            { creator: apply.user_id, friend_id: apply.apply_user_id },
          ];
          for (const pair of pairs) {
            const exists = await friendRepo.findOne({ where: { ...pair, isDeleted: false } });
            if (!exists) await friendRepo.save(pair);
          }
        }

        if (apply.room_id && status) {
          const memberRepo = manager.getRepository(MemberEntity);
          const exists = await memberRepo.findOne({
            where: { room_id: apply.room_id, user_id: apply.user_id, isDeleted: false },
          });
          if (!exists) {
            await memberRepo.save({ room_id: apply.room_id, user_id: apply.user_id });
          }
        }

        // 兜底：事务提交前确认关系真实存在，否则抛错让整个事务回滚
        if (status) {
          const relation = apply.apply_user_id
            ? await manager.getRepository(FriendEntity).findOne({
              where: { creator: apply.apply_user_id, friend_id: apply.user_id, isDeleted: false },
            })
            : await manager.getRepository(MemberEntity).findOne({
              where: { room_id: apply.room_id, user_id: apply.user_id, isDeleted: false },
            });
          if (!relation) {
            throw new HttpException(
              { message: '关系建立失败，申请已回滚，请重试', i18nKey: 'error.apply.relationFailed' },
              500,
            );
          }
        }
      });
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw new HttpException(
        { message: '审批写入失败，请稍后重试', i18nKey: 'error.apply.writeFailed' },
        500,
      );
    }

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

    return { affected: 1 };
  }

  async remove(id: string, operatorId?: string) {
    // 检查是否存在
    const apply = await this.applyRepository.findOne({
      where: { id, isDeleted: false },
      relations: ['room_info'],
    });
    if (!apply) {
      throw new HttpException({ message: '申请不存在', i18nKey: 'error.apply.notFound' }, 404);
    }
    if (apply.handle_status) {
      throw new HttpException({ message: '已处理，不能再操作', i18nKey: 'error.apply.alreadyHandled' }, 409);
    }
    // 只能撤回自己发起的申请（与 worker 侧行为对齐）
    if (!operatorId || apply.user_id !== operatorId) {
      throw new HttpException({ message: '只能撤回自己发起的申请', i18nKey: 'error.apply.onlySelfRevoke' }, 403);
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
