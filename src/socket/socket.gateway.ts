import { OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Logger, UseFilters, UseGuards } from '@nestjs/common';
import { Socket, Server } from 'socket.io';
import { randomUUID } from 'crypto';
import { WsJwtAuthGuard } from '@/socket/socket.guard'
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { FriendEntity } from '@/modules/friend/entities/friend.entity';
import { MemberEntity } from '@/modules/member/entities/member.entity';
import { CallSession, CALL_RING_TIMEOUT, RtcSdpMessage, RtcCandidateMessage } from '@/socket/socket.interface'
import { Event } from '@/socket/events'
import { WsExceptionFilter } from '@/socket/ws-exception.filter'

@WebSocketGateway({
  path: '/websocket',
  serveClient: true,
  namespace: '/',
  cors: {
    origin: '*',
  },
}) // 指定端口号8030
// @WebSocketGateway() // 默认使用服务所用端口-3000
@UseGuards(WsJwtAuthGuard) // 对整个网关的连接应用认证守卫
@UseFilters(new WsExceptionFilter()) // 处理器抛错时回一条 exception，形状与 worker 一致
export class SocketGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() wss: Server;

  private logger: Logger = new Logger('SocketGateway');
  // 在线用户：用户id -> 该用户全部在线 socket（多端/多标签页并存，与 worker 的 userSockets 语义一致）
  // L-2：从单 socket 改为集合，不再「新连接踢旧连接」
  private users = new Map<string, Set<Socket>>();
  // 房间在线名单快照：roomId -> 上一次广播的排序后名单，用于名单 diff（重连风暴防护，与 worker 的 roomOnlineChanged 对齐）
  private roomOnlineSnapshot = new Map<string, string[]>();
  // 通话会话：通话id -> 会话
  private calls = new Map<string, CallSession>();
  // 用户通话索引：用户id -> 通话id（同一时刻只允许一通通话）
  private userCallMap = new Map<string, string>();

  constructor(
    @InjectRepository(FriendEntity)
    private friendRepository: Repository<FriendEntity>,
    @InjectRepository(MemberEntity)
    private memberRepository: Repository<MemberEntity>,
  ){}

  afterInit(server: Server) {
    this.logger.log('WebSocket Gateway Initialized');
  }

  // ======================== 多端在线集合辅助（L-2） ========================

  /** 取用户当前全部在线连接 */
  private userSockets(userId: string): Socket[] {
    const set = this.users.get(userId);
    return set ? Array.from(set) : [];
  }

  /** 用户是否仍在线（任一连接存活即在线） */
  private isOnline(userId: string): boolean {
    return (this.users.get(userId)?.size || 0) > 0;
  }

  /** 注册一条连接（多端并存） */
  private addSocket(userId: string, client: Socket): void {
    let set = this.users.get(userId);
    if (!set) {
      set = new Set<Socket>();
      this.users.set(userId, set);
    }
    set.add(client);
  }

  /** 摘除一条连接；返回该用户是否已完全离线 */
  private removeSocket(userId: string, client: Socket): boolean {
    const set = this.users.get(userId);
    if (!set) return true;
    set.delete(client);
    if (set.size === 0) {
      this.users.delete(userId);
      return true;
    }
    return false;
  }

  async handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    if (!client.data.user) return
    const userId = client.data.user.id;

    // 只摘除断开的这一条连接；多端场景下其它连接仍在线时不算整体下线。
    const offline = this.removeSocket(userId, client);
    // 复核：极端竞态下（集合被并发的 init 重建）不误判整体下线
    if (!offline || this.isOnline(userId)) {
      this.logger.log(`One socket of userId ${userId} disconnected, but other sessions still online`);
      return;
    }

    // 最后一条连接断开 → 真正离线：结束通话、从房间移除、通知好友下线
    this.handleDisconnectCalls(userId);
    // 必须等房间名单更新完成再广播好友下线：之前浮空 Promise 无人接管异常，
    // 还可能与 handleStatus 并发导致「好友先收到离线、房间名单后更新」的乱序
    try {
      await this.handleResigerRooms(client, 'leave');
    } catch (err: any) {
      // 名单更新失败不应吞掉好友下线广播，否则用户会"幽灵在线"
      this.logger.warn(`handleResigerRooms(leave) failed: ${err?.message || err}`);
    }
    await this.handleStatus(client, false);
  }

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
  }

  /**   
   * 发送信息到指定用户
   * @param client 
   * @param message 
   */
  @SubscribeMessage(Event.SEND_USER)
  async handleMessageUser(client: Socket, message: {
    to: string; content: string; clientId?: string; type?: string; size?: number;
    originalname?: string; mentions?: { id: string; name: string }[]
  }): Promise<void> {
    if (!message?.to) return;
    const from = client.data.user.id;
    const to = message.to;
    if (to === from) return;

    // M-3：只允许给好友发私聊。好友关系是双向两条记录，查「我 -> 对方」这一条即可。
    // 对比房间消息已校验 membership，私聊此前完全不校验，任何人可给任意用户灌消息。
    const isFriend = await this.friendRepository.findOne({
      where: { creator: from, friend_id: to, isDeleted: false },
    });
    if (!isFriend) return;

    // 只挑白名单字段，避免把客户端额外塞进 message 的字段透传给收信人
    // originalname（文件名）与 mentions（@ 成员）属于业务字段，契约要求随消息回显
    const { content, clientId, type, size, originalname, mentions } = message;
    const payload = { content, clientId, type, size, originalname, mentions, from, to, timestamp: Date.now() };
    // 多端：发给对方所有在线连接，以及自己的其它端（消息可在多设备同步）
    this.sendToUser(to, Event.MESSAGE_USER, payload);
    client.emit(Event.MESSAGE_USER, payload);
  }


  /**
   * 发送信息到指定房间
   * @param client 
   * @param message 
   */
  @SubscribeMessage(Event.SEND_ROOM)
  handleMessageRoom(client: Socket, message: { roomId: string; content: string; clientId?: string; type?: string; size?: number }): void {
    if (!message?.roomId) return;
    // 服务端必须自己校验成员资格：客户端直接 emit 一个没加入的 roomId，
    // socket.io 照样会把消息投递给该房间，等于任何人可以往任意群里灌消息
    if (!client.rooms.has(message.roomId)) return;
    const payload = Object.assign({}, message, {
      roomId: message.roomId,
      from: client.data.user.id,
      timestamp: Date.now(),
    });
    // 发送给房间内所有成员包括自己
    this.wss.to(message.roomId).emit(Event.MESSAGE_ROOM, payload);
  }

  /**
 * 初始化用户
 * @param client 
 * @param room 
 */
  @SubscribeMessage(Event.INIT)
  async handleInit(client: Socket): Promise<object> {
    this.logger.log(`init 当前用户信息: id: ${client.data.user.id}, username: ${client.data.user.username}`);
    // L-2：多端并存，不再踢掉其它地方的登录（与 worker 的 onInit 一致）。
    // 只把当前连接加入该用户的在线集合；KICKED 事件保留仅作前向兼容，服务端不再主动发。
    this.addSocket(client.data.user.id, client);

    // 获取当前用户所有好友，并通知当前用户已上线
    await this.handleStatus(client, true);

    // 获取当前用户所有房间，通知当前用户已加入房间
    const roomIds = await this.handleResigerRooms(client);

    // ack：客户端可用回调拿到登记完成后的房间与在线名单（worker 端暂不支持 ack，前端保持兼容不依赖它）
    const online: Record<string, string[]> = {};
    for (const roomId of roomIds) online[roomId] = this.roomOnlineSnapshot.get(roomId) || [];
    return { rooms: roomIds, online, timestamp: Date.now() };
  }


  /**
   * 初始化用户所加入的房间
   * @param client
   * @returns 该用户加入的全部房间 id（供 init ack 使用）
   */
  async handleResigerRooms(client: Socket, type: 'join' | 'leave' = 'join'): Promise<string[]> {
    const rooms = await this.memberRepository.find({
      where: {
        user_id: client.data.user.id,
        isDeleted: false,
      },
      relations: ['room_info'],
    });
    const roomIds = (rooms || []).map(room => room.room_id).filter(Boolean);
    for (const roomId of roomIds) client[type](roomId);
    if (!roomIds.length) return roomIds;

    /* 一次拉全：之前是 forEach + 每房间一次 fetchSockets（跨节点 RPC），
       房间多时初始化会明显变慢；另外 forEach 的 async 回调是浮空 Promise，异常无人接管 */
    const sockets = await this.wss.in(roomIds).fetchSockets();
    const onlineByRoom = new Map<string, Set<string>>();
    for (const socket of sockets) {
      for (const roomId of socket.rooms) {
        if (!roomIds.includes(roomId)) continue;
        const list = onlineByRoom.get(roomId) || new Set<string>();
        if (socket.data.user?.id) list.add(socket.data.user.id);
        onlineByRoom.set(roomId, list);
      }
    }
    for (const roomId of roomIds) {
      // 名单统一去重：多端/多标签页同账号会出现重复 id，污染快照与差分
      const users = [...(onlineByRoom.get(roomId) || [])];
      const payload = { roomId, users, timestamp: Date.now() };
      if (this.roomOnlineChanged(roomId, users)) {
        // 名单有变化：广播给全屋
        this.wss.to(roomId).emit(Event.ONLINE_ROOM, payload);
      } else if (type === 'join') {
        // 名单没变（重连 / 多端另一条连接仍在线）：只补发本人，不惊动全屋（对齐 worker 的重连风暴防护）
        client.emit(Event.ONLINE_ROOM, payload);
      }
      // type === 'leave' 且名单没变：该用户其实仍在线，什么都不发
    }
    return roomIds;
  }

  /**
   * 通知所有好友当前用户状态
   * @param client 当前用户
   * @param status 当前用户状态
   */
  async handleStatus(client: Socket, status: boolean) {
    const friends = await this.friendRepository.find({
      where: {
        creator: client.data.user.id,
        isDeleted: false,
      },
    });
    const onlineFriends:string[] = [];
    // 通知所有好友当前用户状态（多端：发给好友的每条在线连接）
    friends.forEach(friend => {
      const receivers = this.userSockets(friend.friend_id);
      if (receivers.length) {
        onlineFriends.push(friend.friend_id);
        const payload = { userId: friend.creator, status, timestamp: Date.now() };
        receivers.forEach(receiver => receiver.emit(Event.STATUS_FRIEND, payload));
      }
    });

    // 如果是上线状态，通知当前用户所有在线好友
    status && client.emit(Event.ONLINE_FRIENDS, {
      users: onlineFriends,
      timestamp: Date.now() // 消息发送时间
    });
  }

  // ======================== 业务事件推送 ========================
  // apply / friend / member / room 模块完成写操作后调用下面三个方法，
  // 事件名与 worker 侧（src/durable/hub.js）保持一致，前端只写一套监听。

  /** 推给某个用户的全部在线连接（多端都会收到） */
  sendToUser(userId: string, event: string, data: any): void {
    if (!userId) return;
    this.userSockets(userId).forEach(socket => socket.emit(event, data));
  }

  /** 推给某个房间的在线成员；excludeUserId 用于排除操作者自己 */
  sendToRoom(roomId: string, event: string, data: any, excludeUserId?: string): void {
    if (!roomId) return;
    if (!excludeUserId) {
      this.wss.to(roomId).emit(event, data);
      return;
    }
    this.users.forEach((sockets, userId) => {
      if (userId === excludeUserId) return;
      sockets.forEach(socket => {
        if (socket.rooms.has(roomId)) socket.emit(event, data);
      });
    });
  }

  /** 成员关系变化后同步房间订阅：新加入的能收消息，退出的收不到（多端：同步该用户全部连接） */
  async syncUserRooms(userId: string): Promise<void> {
    if (!userId) return;
    const sockets = this.userSockets(userId);
    if (!sockets.length) return;

    const members = await this.memberRepository.find({
      where: { user_id: userId, isDeleted: false },
    });
    const target = new Set((members || []).map(item => item.room_id));

    for (const socket of sockets) {
      socket.rooms.forEach((room: string) => {
        if (room === socket.id) return;
        if (!target.has(room)) socket.leave(room);
      });
      target.forEach(room => socket.join(room));
    }
  }

  /**
   * 记录并比对房间在线名单（与 worker 的 roomOnlineChanged / 契约 realtime-contract.md 对齐）。
   * 名单排序后与快照比较：有变化则更新快照并返回 true（需要广播给全屋），
   * 无变化返回 false（重连/多端场景名单没变，只补发触发者本人即可，不惊动全屋）。
   */
  private roomOnlineChanged(roomId: string, users: string[]): boolean {
    const sorted = [...users].sort();
    const prev = this.roomOnlineSnapshot.get(roomId);
    if (prev && JSON.stringify(prev) === JSON.stringify(sorted)) return false;
    this.roomOnlineSnapshot.set(roomId, sorted);
    return true;
  }

  /** 房间解散后清掉快照，避免残留（对齐 worker 的 /drop-room） */
  clearRoomOnlineSnapshot(roomId: string): void {
    this.roomOnlineSnapshot.delete(roomId);
  }

  /** 批量版本：一次 fetchSockets 拿回多个房间的在线名单（overview 用） */
  async roomOnlineMany(roomIds: string[]): Promise<Record<string, string[]>> {
    const result: Record<string, string[]> = {};
    const ids = (roomIds || []).filter(Boolean);
    for (const id of ids) result[id] = [];
    if (!ids.length) return result;
    const sockets = await this.wss.in(ids).fetchSockets();
    // 用 Set 收集：多端/多标签页同账号不产生重复 id（overview 的在线名单直接采用）
    const byRoom = new Map<string, Set<string>>();
    for (const socket of sockets) {
      for (const roomId of socket.rooms) {
        if (ids.includes(roomId) && socket.data.user?.id) {
          const list = byRoom.get(roomId) || new Set<string>();
          list.add(socket.data.user.id);
          byRoom.set(roomId, list);
        }
      }
    }
    byRoom.forEach((list, roomId) => { result[roomId] = [...list]; });
    return result;
  }

  /**
   * 成员加入/退出后向房间全员补发当前在线名单（含新成员自己）。
   * 否则新成员即使在线，也要等别人重连才能出现在在线集合里。
   */
  async pushRoomOnline(roomId: string): Promise<void> {
    if (!roomId) return;
    const sockets = await this.wss.in(roomId).fetchSockets();
    // 去重：多端同账号会产生重复 id，污染快照与差分
    const users = [...new Set(sockets.map(socket => socket.data.user?.id).filter(Boolean))];
    // 名单 diff：没变化就不广播给全屋（对齐契约 line49 与 worker 的 roomOnlineChanged），
    // 避免写操作（尤其被踢/退出）引发无意义的全屋在线人数刷新
    if (!this.roomOnlineChanged(roomId, users)) return;
    this.wss.to(roomId).emit(Event.ONLINE_ROOM, {
      roomId,
      users,
      timestamp: Date.now(),
    });
  }

  /**
   * 好友关系变化后向双向补发当前在线状态。
   * 双方好友列表里刚出现对方（REST 列表不带在线状态），不补发会一直显示离线。
   */
  async pushUserStatus(userId: string): Promise<void> {
    if (!userId) return;
    const online = this.isOnline(userId);
    const friends = await this.friendRepository.find({
      where: { creator: userId, isDeleted: false },
    });
    for (const friend of friends) {
      // 告诉好友我的当前状态（多端：好友的每个连接都收到）
      this.sendToUser(friend.friend_id, Event.STATUS_FRIEND, {
        userId,
        status: online,
        timestamp: Date.now(),
      });
      // 告诉我哪些好友当前在线
      if (online && this.isOnline(friend.friend_id)) {
        this.sendToUser(userId, Event.STATUS_FRIEND, {
          userId: friend.friend_id,
          status: true,
          timestamp: Date.now(),
        });
      }
    }
  }

  // ======================== 语音通话信令 ========================

  /**
   * 释放通话资源（清除定时器、会话与用户索引）
   */
  private releaseCall(session: CallSession): void {
    if (session.ringTimeout) {
      clearTimeout(session.ringTimeout);
      session.ringTimeout = null;
    }
    session.status = 'closed';
    this.calls.delete(session.id);
    if (this.userCallMap.get(session.caller) === session.id) {
      this.userCallMap.delete(session.caller);
    }
    if (this.userCallMap.get(session.callee) === session.id) {
      this.userCallMap.delete(session.callee);
    }
  }

  /**
   * 用户断线时结束其通话并通知对方
   */
  private handleDisconnectCalls(userId: string): void {
    const callId = this.userCallMap.get(userId);
    if (!callId) return;
    const session = this.calls.get(callId);
    if (!session) {
      this.userCallMap.delete(userId);
      return;
    }

    const isCaller = session.caller === userId;
    const peerId = isCaller ? session.callee : session.caller;

    if (this.isOnline(peerId)) {
      if (session.status === 'ringing') {
        // 振铃阶段断线：主叫离开通知被叫取消，被叫离开通知主叫拒绝
        this.sendToUser(peerId, isCaller ? 'call:canceled' : 'call:rejected', {
          callId,
          reason: 'unavailable',
          timestamp: Date.now(),
        });
      } else {
        // 通话阶段断线：通知对方通话结束
        this.sendToUser(peerId, Event.CALL_ENDED, {
          callId,
          reason: 'offline',
          timestamp: Date.now(),
        });
      }
    }
    this.releaseCall(session);
  }

  /**
   * 主叫发起通话邀请（拨打）
   */
  @SubscribeMessage(Event.CALL_INVITE)
  handleCallInvite(client: Socket, payload: { to: string }): void {
    const callerId = client.data.user.id;
    const calleeId = payload?.to;

    if (!calleeId || calleeId === callerId) {
      client.emit(Event.CALL_ERROR, { to: calleeId, reason: 'invalid', timestamp: Date.now() });
      return;
    }

    // 主叫自己已在通话中
    if (this.userCallMap.has(callerId)) {
      client.emit(Event.CALL_ERROR, { to: calleeId, reason: 'busy-self', timestamp: Date.now() });
      return;
    }

    // 被叫不在线
    if (!this.isOnline(calleeId)) {
      client.emit(Event.CALL_ERROR, { to: calleeId, reason: 'offline', timestamp: Date.now() });
      return;
    }

    // 被叫忙线中
    if (this.userCallMap.has(calleeId)) {
      client.emit(Event.CALL_ERROR, { to: calleeId, reason: 'busy', timestamp: Date.now() });
      return;
    }

    const callId = randomUUID();
    const session: CallSession = {
      id: callId,
      caller: callerId,
      callee: calleeId,
      status: 'ringing',
      createdAt: Date.now(),
      ringTimeout: null,
    };
    // 振铃超时自动结束
    session.ringTimeout = setTimeout(() => {
      const current = this.calls.get(callId);
      if (!current || current.status !== 'ringing') return;
      this.sendToUser(current.caller, Event.CALL_TIMEOUT, { callId, timestamp: Date.now() });
      this.sendToUser(current.callee, Event.CALL_CANCELED, { callId, reason: 'timeout', timestamp: Date.now() });
      this.releaseCall(current);
      this.logger.log(`Call ${callId} timeout`);
    }, CALL_RING_TIMEOUT);

    this.calls.set(callId, session);
    this.userCallMap.set(callerId, callId);
    this.userCallMap.set(calleeId, callId);

    // 通知被叫有来电
    this.sendToUser(calleeId, Event.CALL_INCOMING, {
      callId,
      from: callerId,
      username: client.data.user.username,
      timestamp: Date.now(),
    });
    // 通知主叫正在振铃
    client.emit(Event.CALL_RINGING, { callId, to: calleeId, timestamp: Date.now() });
    this.logger.log(`Call ${callId} invite: ${callerId} -> ${calleeId}`);
  }

  /**
   * 被叫接听通话
   */
  @SubscribeMessage(Event.CALL_ACCEPT)
  handleCallAccept(client: Socket, payload: { callId: string }): void {
    const session = this.calls.get(payload?.callId);
    if (!session || session.callee !== client.data.user.id || session.status !== 'ringing') {
      client.emit(Event.CALL_ERROR, { callId: payload?.callId, reason: 'unavailable', timestamp: Date.now() });
      return;
    }

    // 主叫已离开
    if (!this.isOnline(session.caller)) {
      this.releaseCall(session);
      client.emit(Event.CALL_ENDED, { callId: session.id, reason: 'offline', timestamp: Date.now() });
      return;
    }

    if (session.ringTimeout) {
      clearTimeout(session.ringTimeout);
      session.ringTimeout = null;
    }
    session.status = 'active';
    this.sendToUser(session.caller, Event.CALL_ACCEPTED, { callId: session.id, from: session.callee, timestamp: Date.now() });
    this.logger.log(`Call ${session.id} accepted by ${session.callee}`);
  }

  /**
   * 被叫拒绝通话
   */
  @SubscribeMessage(Event.CALL_REJECT)
  handleCallReject(client: Socket, payload: { callId: string }): void {
    const session = this.calls.get(payload?.callId);
    if (!session || session.callee !== client.data.user.id) return;

    this.sendToUser(session.caller, Event.CALL_REJECTED, {
      callId: session.id,
      timestamp: Date.now(),
    });
    this.releaseCall(session);
    this.logger.log(`Call ${session.id} rejected by ${session.callee}`);
  }

  /**
   * 主叫取消通话（振铃阶段挂断）
   */
  @SubscribeMessage(Event.CALL_CANCEL)
  handleCallCancel(client: Socket, payload: { callId: string }): void {
    const session = this.calls.get(payload?.callId);
    if (!session || session.caller !== client.data.user.id) return;

    this.sendToUser(session.callee, Event.CALL_CANCELED, {
      callId: session.id,
      timestamp: Date.now(),
    });
    this.releaseCall(session);
    this.logger.log(`Call ${session.id} canceled by ${session.caller}`);
  }

  /**
   * 任意一方结束通话（挂断）
   */
  @SubscribeMessage(Event.CALL_END)
  handleCallEnd(client: Socket, payload: { callId: string }): void {
    const session = this.calls.get(payload?.callId);
    if (!session) return;

    const userId = client.data.user.id;
    if (session.caller !== userId && session.callee !== userId) return;

    const peerId = session.caller === userId ? session.callee : session.caller;
    this.sendToUser(peerId, Event.CALL_ENDED, {
      callId: session.id,
      reason: 'hangup',
      timestamp: Date.now(),
    });
    this.releaseCall(session);
    this.logger.log(`Call ${session.id} ended by ${userId}`);
  }

  /**
   * 转发 WebRTC Offer
   */
  @SubscribeMessage(Event.WEBRTC_OFFER)
  handleWebRtcOffer(client: Socket, payload: { callId: string; sdp: RtcSdpMessage }): void {
    const peer = this.getCallPeer(client, payload?.callId);
    if (!peer) return;
    const data = { callId: peer.session.id, from: client.data.user.id, sdp: payload.sdp };
    peer.sockets.forEach(socket => socket.emit(Event.WEBRTC_OFFER, data));
  }

  /**
   * 转发 WebRTC Answer
   */
  @SubscribeMessage(Event.WEBRTC_ANSWER)
  handleWebRtcAnswer(client: Socket, payload: { callId: string; sdp: RtcSdpMessage }): void {
    const peer = this.getCallPeer(client, payload?.callId);
    if (!peer) return;
    const data = { callId: peer.session.id, from: client.data.user.id, sdp: payload.sdp };
    peer.sockets.forEach(socket => socket.emit(Event.WEBRTC_ANSWER, data));
  }

  /**
   * 转发 WebRTC ICE Candidate
   */
  @SubscribeMessage(Event.WEBRTC_CANDIDATE)
  handleWebRtcCandidate(client: Socket, payload: { callId: string; candidate: RtcCandidateMessage }): void {
    const peer = this.getCallPeer(client, payload?.callId);
    if (!peer) return;
    const data = { callId: peer.session.id, from: client.data.user.id, candidate: payload.candidate };
    peer.sockets.forEach(socket => socket.emit(Event.WEBRTC_CANDIDATE, data));
  }

  /**
   * 校验当前用户属于通话且通话已接通，返回对方的全部在线连接与会话（多端对齐 worker）
   */
  private getCallPeer(client: Socket, callId: string): { sockets: Socket[]; session: CallSession } | null {
    const session = this.calls.get(callId);
    if (!session || session.status !== 'active') return null;

    const userId = client.data.user.id;
    if (session.caller !== userId && session.callee !== userId) return null;

    const peerId = session.caller === userId ? session.callee : session.caller;
    const sockets = this.userSockets(peerId);
    if (!sockets.length) return null;

    return { sockets, session };
  }
  // ======================== 语音通话信令 END ========================
}
