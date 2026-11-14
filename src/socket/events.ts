/**
 * 实时事件名 —— 唯一事实来源（nestjs 侧）
 *
 * 必须与下面两处保持完全一致：
 *   - Discuss/src/constants/events.ts
 *   - Discuss/worker/src/lib/events.js
 *
 * 命名约定（详见 Discuss/docs/realtime-contract.md）：
 *   1. 房间标识统一 roomId（可带 roomName），用户标识统一 userId（可带 username）
 *   2. 消息方向统一 from / to
 *   3. 不保留历史别名（status:firend 已移除）
 */
export const Event = {
  /* 客户端 → 服务端 */
  INIT: 'init',
  SEND_USER: 'send:user',
  SEND_ROOM: 'send:room',
  CALL_INVITE: 'call:invite',
  CALL_ACCEPT: 'call:accept',
  CALL_REJECT: 'call:reject',
  CALL_CANCEL: 'call:cancel',
  CALL_END: 'call:end',
  WEBRTC_OFFER: 'webrtc:offer',
  WEBRTC_ANSWER: 'webrtc:answer',
  WEBRTC_CANDIDATE: 'webrtc:candidate',

  /* 服务端 → 客户端：连接与消息 */
  MESSAGE_USER: 'message:user',
  MESSAGE_ROOM: 'message:room',

  /* 服务端 → 客户端：在线状态 */
  ONLINE_ROOM: 'online:room',
  ONLINE_FRIENDS: 'online:friends',
  STATUS_FRIEND: 'status:friend',
  KICKED: 'kicked',

  /* 服务端 → 客户端：好友 */
  FRIEND_REQUEST: 'friend:request',
  FRIEND_ACCEPTED: 'friend:accepted',
  FRIEND_REJECTED: 'friend:rejected',
  FRIEND_ADDED: 'friend:added',
  FRIEND_REMOVED: 'friend:removed',

  /* 服务端 → 客户端：房间与申请 */
  APPLY_REVOKED: 'apply:revoked',
  ROOM_APPLY: 'room:apply',
  ROOM_APPLY_RESULT: 'room:apply:result',
  ROOM_JOINED: 'room:joined',
  ROOM_UPDATED: 'room:updated',
  ROOM_LEFT: 'room:left',
  ROOM_KICKED: 'room:kicked',
  ROOM_DELETED: 'room:deleted',
  MEMBER_JOINED: 'member:joined',
  MEMBER_REMOVED: 'member:removed',

  /* 服务端 → 客户端：系统 */
  SYSTEM_ALERT: 'system:alert',
  EXCEPTION: 'exception',

  /* 服务端 → 客户端：通话 */
  CALL_INCOMING: 'call:incoming',
  CALL_RINGING: 'call:ringing',
  CALL_ACCEPTED: 'call:accepted',
  CALL_REJECTED: 'call:rejected',
  CALL_CANCELED: 'call:canceled',
  CALL_TIMEOUT: 'call:timeout',
  CALL_ENDED: 'call:ended',
  CALL_ERROR: 'call:error',
} as const;

export type EventName = (typeof Event)[keyof typeof Event];
