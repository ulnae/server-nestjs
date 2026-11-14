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
  // 在线用户：用户id -> socket
  private users = new Map<string, Socket>();
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

  async handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    if (!client.data.user) return

    if (this.users.get(client.data.user.id) && this.users.get(client.data.user.id)?.id == client.id) {
      // 用户断线时，结束其进行中的通话并通知对方
      this.handleDisconnectCalls(client.data.user.id);
      // 从用户房间中移除用户
      this.handleResigerRooms(client,'leave');
      // 获取当前用户所有好友，并通知当前用户已下线
      await this.handleStatus(client, false);
      // 从用户映射中移除用户
      this.users.delete(client.data.user.id);
    } else {
      this.logger.log(`Ignored disconnect for old socket of userId: ${client.data.user.id}`);
    }
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
  handleMessageUser(client: Socket, message: { to: string; content: string; clientId?: string; type?: string; size?: number }): void {
    if (!message?.to) return;
    const to = message.to;
    // 收发双方使用同一个事件：收信人靠 from 判断发送者，发送方靠 clientId 对账乐观消息
    const payload = Object.assign({}, message, {
      from: client.data.user.id,
      to,
      timestamp: Date.now(),
    });
    this.users.get(to)?.emit(Event.MESSAGE_USER, payload);
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
  async handleInit(client: Socket): Promise<void> {
    this.logger.log(`init 当前用户信息: id: ${client.data.user.id}, username: ${client.data.user.username}`);
    // 踢掉其他地方登录的账号（worker 允许多端，这里保留单端语义，见 realtime-contract.md）
    this.users.get(client.data.user.id)?.emit(Event.KICKED, { 
      reason: 'Account logged in elsewhere', 
      timestamp: Date.now() 
    });
    this.users.get(client.data.user.id)?.disconnect(true)
    // 记录用户id和对应的client映射关系
    this.users.set(client.data.user.id, client);
    
    // 获取当前用户所有好友，并通知当前用户已上线
    await this.handleStatus(client, true);
 
    // 获取当前用户所有房间，通知当前用户已加入房间
    await this.handleResigerRooms(client);
  }


  /**
   * 初始化用户所加入的房间
   * @param client 
   */
  async handleResigerRooms(client: Socket, type: 'join' | 'leave' = 'join') {
    const rooms = await this.memberRepository.find({
      where: {
        user_id: client.data.user.id,
        isDeleted: false,
      },
      relations: ['room_info'],
    });
    const roomIds = (rooms || []).map(room => room.room_id).filter(Boolean);
    for (const roomId of roomIds) client[type](roomId);
    if (!roomIds.length) return;

    /* 一次拉全：之前是 forEach + 每房间一次 fetchSockets（跨节点 RPC），
       房间多时初始化会明显变慢；另外 forEach 的 async 回调是浮空 Promise，异常无人接管 */
    const sockets = await this.wss.in(roomIds).fetchSockets();
    const onlineByRoom = new Map<string, string[]>();
    for (const socket of sockets) {
      for (const roomId of socket.rooms) {
        if (!roomIds.includes(roomId)) continue;
        const list = onlineByRoom.get(roomId) || [];
        if (socket.data.user?.id) list.push(socket.data.user.id);
        onlineByRoom.set(roomId, list);
      }
    }
    for (const roomId of roomIds) {
      this.wss.to(roomId).emit(Event.ONLINE_ROOM, {
        roomId,
        users: onlineByRoom.get(roomId) || [],
        timestamp: Date.now(),
      });
    }
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
    // 通知所有好友当前用户状态
    friends.forEach(friend => {
      const receiver = this.users.get(friend.friend_id);
      if (receiver) {
        onlineFriends.push(friend.friend_id);
        receiver.emit(Event.STATUS_FRIEND, {
          userId: friend.creator,
          status,
          timestamp: Date.now()
        });
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

  /** 推给某个用户（在线才会收到） */
  sendToUser(userId: string, event: string, data: any): void {
    if (!userId) return;
    this.users.get(userId)?.emit(event, data);
  }

  /** 推给某个房间的在线成员；excludeUserId 用于排除操作者自己 */
  sendToRoom(roomId: string, event: string, data: any, excludeUserId?: string): void {
    if (!roomId) return;
    if (!excludeUserId) {
      this.wss.to(roomId).emit(event, data);
      return;
    }
    this.users.forEach((socket, userId) => {
      if (userId === excludeUserId) return;
      if (socket.rooms.has(roomId)) socket.emit(event, data);
    });
  }

  /** 成员关系变化后同步房间订阅：新加入的能收消息，退出的收不到 */
  async syncUserRooms(userId: string): Promise<void> {
    if (!userId) return;
    const socket = this.users.get(userId);
    if (!socket) return;

    const members = await this.memberRepository.find({
      where: { user_id: userId, isDeleted: false },
    });
    const target = new Set((members || []).map(item => item.room_id));

    socket.rooms.forEach((room: string) => {
      if (room === socket.id) return;
      if (!target.has(room)) socket.leave(room);
    });
    target.forEach(room => socket.join(room));
  }

  /**
   * 查询某房间当前在线用户 id 列表（供聚合接口 /room/overview 使用）
   */
  async roomOnline(roomId: string): Promise<string[]> {
    if (!roomId) return [];
    const sockets = await this.wss.in(roomId).fetchSockets();
    return sockets.map(socket => socket.data.user?.id).filter(Boolean);
  }

  /** 批量版本：一次 fetchSockets 拿回多个房间的在线名单（overview 用） */
  async roomOnlineMany(roomIds: string[]): Promise<Record<string, string[]>> {
    const result: Record<string, string[]> = {};
    const ids = (roomIds || []).filter(Boolean);
    for (const id of ids) result[id] = [];
    if (!ids.length) return result;
    const sockets = await this.wss.in(ids).fetchSockets();
    for (const socket of sockets) {
      for (const roomId of socket.rooms) {
        if (!result[roomId]) continue;
        if (socket.data.user?.id) result[roomId].push(socket.data.user.id);
      }
    }
    return result;
  }

  /**
   * 成员加入/退出后向房间全员补发当前在线名单（含新成员自己）。
   * 否则新成员即使在线，也要等别人重连才能出现在在线集合里。
   */
  async pushRoomOnline(roomId: string): Promise<void> {
    if (!roomId) return;
    const sockets = await this.wss.in(roomId).fetchSockets();
    this.wss.to(roomId).emit(Event.ONLINE_ROOM, {
      roomId,
      users: sockets.map(socket => socket.data.user?.id),
      timestamp: Date.now(),
    });
  }

  /**
   * 好友关系变化后向双向补发当前在线状态。
   * 双方好友列表里刚出现对方（REST 列表不带在线状态），不补发会一直显示离线。
   */
  async pushUserStatus(userId: string): Promise<void> {
    if (!userId) return;
    const online = this.users.has(userId);
    const friends = await this.friendRepository.find({
      where: { creator: userId, isDeleted: false },
    });
    for (const friend of friends) {
      // 告诉好友我的当前状态
      this.users.get(friend.friend_id)?.emit(Event.STATUS_FRIEND, {
        userId,
        status: online,
        timestamp: Date.now(),
      });
      // 告诉我哪些好友当前在线
      if (online && this.users.has(friend.friend_id)) {
        this.users.get(userId)?.emit(Event.STATUS_FRIEND, {
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
    const peer = this.users.get(peerId);

    if (peer) {
      if (session.status === 'ringing') {
        // 振铃阶段断线：主叫离开通知被叫取消，被叫离开通知主叫拒绝
        peer.emit(isCaller ? 'call:canceled' : 'call:rejected', {
          callId,
          reason: 'unavailable',
          timestamp: Date.now(),
        });
      } else {
        // 通话阶段断线：通知对方通话结束
        peer.emit(Event.CALL_ENDED, {
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

    const callee = this.users.get(calleeId);
    // 被叫不在线
    if (!callee) {
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
      this.users.get(current.caller)?.emit(Event.CALL_TIMEOUT, { callId, timestamp: Date.now() });
      this.users.get(current.callee)?.emit(Event.CALL_CANCELED, { callId, reason: 'timeout', timestamp: Date.now() });
      this.releaseCall(current);
      this.logger.log(`Call ${callId} timeout`);
    }, CALL_RING_TIMEOUT);

    this.calls.set(callId, session);
    this.userCallMap.set(callerId, callId);
    this.userCallMap.set(calleeId, callId);

    // 通知被叫有来电
    callee.emit(Event.CALL_INCOMING, {
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

    const caller = this.users.get(session.caller);
    // 主叫已离开
    if (!caller) {
      this.releaseCall(session);
      client.emit(Event.CALL_ENDED, { callId: session.id, reason: 'offline', timestamp: Date.now() });
      return;
    }

    if (session.ringTimeout) {
      clearTimeout(session.ringTimeout);
      session.ringTimeout = null;
    }
    session.status = 'active';
    caller.emit(Event.CALL_ACCEPTED, { callId: session.id, from: session.callee, timestamp: Date.now() });
    this.logger.log(`Call ${session.id} accepted by ${session.callee}`);
  }

  /**
   * 被叫拒绝通话
   */
  @SubscribeMessage(Event.CALL_REJECT)
  handleCallReject(client: Socket, payload: { callId: string }): void {
    const session = this.calls.get(payload?.callId);
    if (!session || session.callee !== client.data.user.id) return;

    this.users.get(session.caller)?.emit(Event.CALL_REJECTED, {
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

    this.users.get(session.callee)?.emit(Event.CALL_CANCELED, {
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
    this.users.get(peerId)?.emit(Event.CALL_ENDED, {
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
    peer.socket.emit(Event.WEBRTC_OFFER, {
      callId: peer.session.id,
      from: client.data.user.id,
      sdp: payload.sdp,
    });
  }

  /**
   * 转发 WebRTC Answer
   */
  @SubscribeMessage(Event.WEBRTC_ANSWER)
  handleWebRtcAnswer(client: Socket, payload: { callId: string; sdp: RtcSdpMessage }): void {
    const peer = this.getCallPeer(client, payload?.callId);
    if (!peer) return;
    peer.socket.emit(Event.WEBRTC_ANSWER, {
      callId: peer.session.id,
      from: client.data.user.id,
      sdp: payload.sdp,
    });
  }

  /**
   * 转发 WebRTC ICE Candidate
   */
  @SubscribeMessage(Event.WEBRTC_CANDIDATE)
  handleWebRtcCandidate(client: Socket, payload: { callId: string; candidate: RtcCandidateMessage }): void {
    const peer = this.getCallPeer(client, payload?.callId);
    if (!peer) return;
    peer.socket.emit(Event.WEBRTC_CANDIDATE, {
      callId: peer.session.id,
      from: client.data.user.id,
      candidate: payload.candidate,
    });
  }

  /**
   * 校验当前用户属于通话且通话已接通，返回对方socket与会话
   */
  private getCallPeer(client: Socket, callId: string): { socket: Socket; session: CallSession } | null {
    const session = this.calls.get(callId);
    if (!session || session.status !== 'active') return null;

    const userId = client.data.user.id;
    if (session.caller !== userId && session.callee !== userId) return null;

    const peerId = session.caller === userId ? session.callee : session.caller;
    const peerSocket = this.users.get(peerId);
    if (!peerSocket) return null;

    return { socket: peerSocket, session };
  }
  // ======================== 语音通话信令 END ========================
}
