import { OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { OnGatewayConnection, OnGatewayDisconnect } from '@nestjs/websockets';
import { Logger, UseGuards } from '@nestjs/common';
import { Socket, Server } from 'socket.io';
import { randomUUID } from 'crypto';
import { WsJwtAuthGuard } from '@/socket/socket.guard'
import { Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { FriendEntity } from '@/modules/friend/entities/friend.entity';
import { MemberEntity } from '@/modules/member/entities/member.entity';
import { CallSession, CALL_RING_TIMEOUT, RtcSdpMessage, RtcCandidateMessage } from '@/socket/socket.interface'

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
    client.emit('message', { message: `Welcome to the WebSocket server!`, timestamp: Date.now() });
  }

  /**   
   * 接收客户端发送的消息
   * @param client 
   * @param message 
   */
  @SubscribeMessage('message')
  handleMessage(client: Socket, message: string): void {
    console.log('Message from client:', message);
  }


  /**   
   * 发送信息到指定用户
   * @param client 
   * @param message 
   */
  @SubscribeMessage('user')
  handleMessageUser(client: Socket, message: { sender: string, message: string }): void {
    // 需要记录用户id和对应的client映射关系才能实现
    const receiver = this.users.get(message.sender);
    const msg = Object.assign({}, message, { 
      sender: client.data.user.id, // 发送方id
      receiver: message.sender, // 接收方id
      timestamp: Date.now() // 消息发送时间
    });
    if (receiver) {
      receiver.emit('message:user', msg); // 发送给指定用户
    } else {
      this.logger.error(`User ${message.sender} not found`);
    }
    client.emit('message:sender', msg); // 回显给发送方
    // TODO 记录用户之间的消息记录 - 数据库
    // { message, sender: client.data.user.id, receiver: message.sender, timestamp: Date.now() }
  }


  /**
   * 发送信息到指定房间
   * @param client 
   * @param message 
   */
  @SubscribeMessage('room')
  handleMessageRoom(client: Socket, message: { room: string, message: string }): void {
    // client.to(message.room).emit('msg2client', message); // 发送给除了自己之外的房间内成员 - 群公告
    this.wss.to(message.room).emit('message:room', Object.assign({}, message, {
      sender: client.data.user.id, // 发送方id
      timestamp: Date.now() // 消息发送时间
    })); // 发送给房间内所有成员包括自己
  }

  /**
 * 初始化用户
 * @param client 
 * @param room 
 */
  @SubscribeMessage('init')
  async handleInit(client: Socket): Promise<void> {
    this.logger.log(`init 当前用户信息: id: ${client.data.user.id}, username: ${client.data.user.username}`);
    // 踢掉其他地方登录的账号
    this.users.get(client.data.user.id)?.emit('kicked', { 
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
    rooms.forEach(async room => {
      // 加入房间/离开房间
      client[type](room.room_id);

      // 获取当前房间所有成员
      const sockets = await this.wss.in(room.room_id).fetchSockets();
      // 通知房间内所有成员当前房间活跃用户
      this.wss.to(room.room_id).emit('online:room', {
        room: room.room_id,
        users: sockets.map(socket => socket.data.user?.id),
        timestamp: Date.now() // 消息发送时间
      }); // 发送给房间内所有成员包括自己

      // 
      // client.emit(type, { room: room.room_id, message: `You have ${type} room: ${room.room_info.name}` });
    });
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
        receiver.emit('status:firend', {
          friend: friend.creator,
          status,
          timestamp: Date.now() // 消息发送时间
        }); // 发送给房间内所有成员包括自己
      } else {
        this.logger.error(`User ${friend.friend_id} not found`);
      }
    });

    // 如果是上线状态，通知当前用户所有在线好友
    status && client.emit('online:friends', {
      users: onlineFriends,
      timestamp: Date.now() // 消息发送时间
    });
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
        peer.emit('call:ended', {
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
  @SubscribeMessage('call:invite')
  handleCallInvite(client: Socket, payload: { to: string }): void {
    const callerId = client.data.user.id;
    const calleeId = payload?.to;

    if (!calleeId || calleeId === callerId) {
      client.emit('call:error', { to: calleeId, reason: 'invalid', timestamp: Date.now() });
      return;
    }

    // 主叫自己已在通话中
    if (this.userCallMap.has(callerId)) {
      client.emit('call:error', { to: calleeId, reason: 'busy-self', timestamp: Date.now() });
      return;
    }

    const callee = this.users.get(calleeId);
    // 被叫不在线
    if (!callee) {
      client.emit('call:error', { to: calleeId, reason: 'offline', timestamp: Date.now() });
      return;
    }

    // 被叫忙线中
    if (this.userCallMap.has(calleeId)) {
      client.emit('call:error', { to: calleeId, reason: 'busy', timestamp: Date.now() });
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
      this.users.get(current.caller)?.emit('call:timeout', { callId, timestamp: Date.now() });
      this.users.get(current.callee)?.emit('call:canceled', { callId, reason: 'timeout', timestamp: Date.now() });
      this.releaseCall(current);
      this.logger.log(`Call ${callId} timeout`);
    }, CALL_RING_TIMEOUT);

    this.calls.set(callId, session);
    this.userCallMap.set(callerId, callId);
    this.userCallMap.set(calleeId, callId);

    // 通知被叫有来电
    callee.emit('call:incoming', {
      callId,
      from: callerId,
      username: client.data.user.username,
      timestamp: Date.now(),
    });
    // 通知主叫正在振铃
    client.emit('call:ringing', { callId, to: calleeId, timestamp: Date.now() });
    this.logger.log(`Call ${callId} invite: ${callerId} -> ${calleeId}`);
  }

  /**
   * 被叫接听通话
   */
  @SubscribeMessage('call:accept')
  handleCallAccept(client: Socket, payload: { callId: string }): void {
    const session = this.calls.get(payload?.callId);
    if (!session || session.callee !== client.data.user.id || session.status !== 'ringing') {
      client.emit('call:error', { callId: payload?.callId, reason: 'unavailable', timestamp: Date.now() });
      return;
    }

    const caller = this.users.get(session.caller);
    // 主叫已离开
    if (!caller) {
      this.releaseCall(session);
      client.emit('call:ended', { callId: session.id, reason: 'offline', timestamp: Date.now() });
      return;
    }

    if (session.ringTimeout) {
      clearTimeout(session.ringTimeout);
      session.ringTimeout = null;
    }
    session.status = 'active';
    caller.emit('call:accepted', { callId: session.id, from: session.callee, timestamp: Date.now() });
    this.logger.log(`Call ${session.id} accepted by ${session.callee}`);
  }

  /**
   * 被叫拒绝通话
   */
  @SubscribeMessage('call:reject')
  handleCallReject(client: Socket, payload: { callId: string }): void {
    const session = this.calls.get(payload?.callId);
    if (!session || session.callee !== client.data.user.id) return;

    this.users.get(session.caller)?.emit('call:rejected', {
      callId: session.id,
      timestamp: Date.now(),
    });
    this.releaseCall(session);
    this.logger.log(`Call ${session.id} rejected by ${session.callee}`);
  }

  /**
   * 主叫取消通话（振铃阶段挂断）
   */
  @SubscribeMessage('call:cancel')
  handleCallCancel(client: Socket, payload: { callId: string }): void {
    const session = this.calls.get(payload?.callId);
    if (!session || session.caller !== client.data.user.id) return;

    this.users.get(session.callee)?.emit('call:canceled', {
      callId: session.id,
      timestamp: Date.now(),
    });
    this.releaseCall(session);
    this.logger.log(`Call ${session.id} canceled by ${session.caller}`);
  }

  /**
   * 任意一方结束通话（挂断）
   */
  @SubscribeMessage('call:end')
  handleCallEnd(client: Socket, payload: { callId: string }): void {
    const session = this.calls.get(payload?.callId);
    if (!session) return;

    const userId = client.data.user.id;
    if (session.caller !== userId && session.callee !== userId) return;

    const peerId = session.caller === userId ? session.callee : session.caller;
    this.users.get(peerId)?.emit('call:ended', {
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
  @SubscribeMessage('webrtc:offer')
  handleWebRtcOffer(client: Socket, payload: { callId: string; sdp: RtcSdpMessage }): void {
    const peer = this.getCallPeer(client, payload?.callId);
    if (!peer) return;
    peer.socket.emit('webrtc:offer', {
      callId: peer.session.id,
      from: client.data.user.id,
      sdp: payload.sdp,
    });
  }

  /**
   * 转发 WebRTC Answer
   */
  @SubscribeMessage('webrtc:answer')
  handleWebRtcAnswer(client: Socket, payload: { callId: string; sdp: RtcSdpMessage }): void {
    const peer = this.getCallPeer(client, payload?.callId);
    if (!peer) return;
    peer.socket.emit('webrtc:answer', {
      callId: peer.session.id,
      from: client.data.user.id,
      sdp: payload.sdp,
    });
  }

  /**
   * 转发 WebRTC ICE Candidate
   */
  @SubscribeMessage('webrtc:candidate')
  handleWebRtcCandidate(client: Socket, payload: { callId: string; candidate: RtcCandidateMessage }): void {
    const peer = this.getCallPeer(client, payload?.callId);
    if (!peer) return;
    peer.socket.emit('webrtc:candidate', {
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
