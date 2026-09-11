/**
 * 语音通话会话
 */
export interface CallSession {
  // 通话id
  id: string;
  // 主叫用户id
  caller: string;
  // 被叫用户id
  callee: string;
  // 通话状态：ringing-振铃中 active-通话中 closed-已结束
  status: 'ringing' | 'active' | 'closed';
  // 创建时间
  createdAt: number;
  // 振铃超时定时器
  ringTimeout: NodeJS.Timeout | null;
}

// 振铃超时时间（毫秒），超时自动取消通话
export const CALL_RING_TIMEOUT = 30 * 1000;

// WebRTC SDP 描述（信令服务器只负责转发，不关心内部结构）
export interface RtcSdpMessage {
  type: string;
  sdp: string;
}

// WebRTC ICE 候选者（信令服务器只负责转发，不关心内部结构）
export type RtcCandidateMessage = Record<string, unknown>;