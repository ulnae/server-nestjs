import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** 短期凭证有效期（秒） */
const TTL = 3600;
/** 同一进程内缓存 5 分钟，避免每次拨号都调一次供应商 API */
const CACHE_TTL = 5 * 60 * 1000;
/** 最终兜底：只有 STUN，跨严格 NAT 无法中继但保证流程不报错 */
const STUN_ONLY: IceServer[] = [{ urls: 'stun:stun.cloudflare.com:3478' }];

type IceServer = { urls: string | string[]; username?: string; credential?: string };
type IceResult = { iceServers: IceServer[]; turn: boolean; ttl?: number; provider?: string };

@Injectable()
export class RtcService {
  private readonly logger = new Logger(RtcService.name);
  private cache: { at: number; iceServers: IceServer[]; turn: boolean; provider?: string } = {
    at: 0,
    iceServers: [],
    turn: false,
  };

  constructor(private readonly configService: ConfigService) {}

  /**
   * TURN 凭证下发（多层供应商，自动降级）：
   *   1. Cloudflare Realtime TURN（需绑卡，1000GB/月免费）
   *   2. Metered Open Relay（免费注册即可，无需绑卡，20GB/月）
   *   3. Cloudflare STUN 兜底（免费不限量、国内可达）
   */
  async iceServers(): Promise<IceResult> {
    if (this.cache.iceServers.length && Date.now() - this.cache.at < CACHE_TTL) {
      return { iceServers: this.cache.iceServers, turn: this.cache.turn, provider: this.cache.provider };
    }

    /* 1. Cloudflare Realtime TURN */
    const keyId = String(this.configService.get('TURN_KEY_ID') || '').trim();
    const apiToken = String(this.configService.get('TURN_KEY_API_TOKEN') || '').trim();
    if (keyId && apiToken) {
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

        this.cache = { at: Date.now(), iceServers, turn: true, provider: 'cloudflare' };
        return { iceServers, turn: true, ttl: TTL, provider: 'cloudflare' };
      } catch (error) {
        this.logger.warn(`cloudflare turn credential failed: ${(error as Error)?.message || error}`);
      }
    }

    /* 2. Metered Open Relay（免费账号，无需绑卡） */
    const meteredApp = String(this.configService.get('METERED_APP_NAME') || '').trim();
    const meteredKey = String(this.configService.get('METERED_API_KEY') || '').trim();
    if (meteredApp && meteredKey) {
      try {
        const res = await fetch(
          `https://${encodeURIComponent(meteredApp)}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(meteredKey)}`,
        );
        if (!res.ok) throw new Error(`metered turn ${res.status}`);
        const data: any = await res.json();
        const iceServers: IceServer[] = Array.isArray(data?.iceServers) ? data.iceServers : [];
        if (!iceServers.length) throw new Error('empty iceServers');

        this.cache = { at: Date.now(), iceServers, turn: true, provider: 'metered' };
        return { iceServers, turn: true, provider: 'metered' };
      } catch (error) {
        this.logger.warn(`metered turn credential failed: ${(error as Error)?.message || error}`);
      }
    }

    /* 3. STUN 兜底，不阻断通话建立 */
    return { iceServers: STUN_ONLY, turn: false, provider: 'stun' };
  }
}
