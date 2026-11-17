import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** 短期凭证有效期（秒） */
const TTL = 3600;
/** 同一进程内缓存 5 分钟，避免每次拨号都调一次 Cloudflare API */
const CACHE_TTL = 5 * 60 * 1000;
/**
 * 三层兜底：STUN 永远保留（免费不限量、国内可达）；
 * openrelay 公共 TURN 是跨严格 NAT 的第二道保险（凭证公开、无 SLA，
 * 连不通时 ICE 会自动放弃 relay 候选，不会比只有 STUN 更差）。
 * 只放 :80 UDP 和 :443 TCP 两条，减少无效候选、加快 ICE 收敛。
 */
const FALLBACK_ICE_SERVERS: IceServer[] = [
  { urls: 'stun:stun.cloudflare.com:3478' },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443?transport=tcp',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

type IceServer = { urls: string | string[]; username?: string; credential?: string };

@Injectable()
export class RtcService {
  private readonly logger = new Logger(RtcService.name);
  private cache: { at: number; iceServers: IceServer[] } = { at: 0, iceServers: [] };

  constructor(private readonly configService: ConfigService) {}

  /**
   * 下发 Cloudflare Realtime TURN 短期凭证。
   * TURN Key 的 API Token 是长期密钥，只能留在服务端换短期凭证。
   */
  async iceServers(): Promise<{ iceServers: IceServer[]; turn: boolean; ttl?: number }> {
    const keyId = String(this.configService.get('TURN_KEY_ID') || '').trim();
    const apiToken = String(this.configService.get('TURN_KEY_API_TOKEN') || '').trim();
    if (!keyId || !apiToken) return { iceServers: FALLBACK_ICE_SERVERS, turn: false };

    if (this.cache.iceServers.length && Date.now() - this.cache.at < CACHE_TTL) {
      return { iceServers: this.cache.iceServers, turn: true };
    }

    try {
      const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ttl: TTL }),
        },
      );
      if (!res.ok) throw new Error(`cloudflare turn ${res.status}`);
      const data: any = await res.json();
      const iceServers: IceServer[] = Array.isArray(data?.iceServers) ? data.iceServers : [];
      if (!iceServers.length) throw new Error('empty iceServers');

      this.cache = { at: Date.now(), iceServers };
      return { iceServers, turn: true, ttl: TTL };
    } catch (error) {
      // 拿不到凭证时降级 STUN，不阻断通话建立
      this.logger.warn(`turn credential failed: ${(error as Error)?.message || error}`);
      return { iceServers: FALLBACK_ICE_SERVERS, turn: false };
    }
  }
}
