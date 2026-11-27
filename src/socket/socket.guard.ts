import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io'; // 若使用 socket.io 适配器
import { ConfigService } from '@nestjs/config';

@Injectable()
export class WsJwtAuthGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private configService: ConfigService
  ) { }
  
  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    // 切换到 WebSocket 上下文，获取客户端连接对象（socket.io 的客户端类型为 Socket）
    const client: Socket = context.switchToWs().getClient();

    // 从连接的 query 参数中提取 token（客户端传递的参数）
    let token = client.handshake.auth.token;
    if (!token) {
      throw new WsException({ message: 'WebSocket 连接缺少 Token', i18nKey: 'error.auth.wsTokenMissing' }); // WebSocket 专用异常
    }


    // 处理 Bearer 前缀（若有）
    if (token.startsWith('Bearer ')) {
      token = token.slice(7);
    }

    try {
      // 验证 Token 并解析 payload（需与 JWT 模块配置的密钥一致）
      const payload = this.jwtService.verify(token, {
        secret: this.configService.get('JWT_SECRET'), // 建议从环境变量读取
      });

      // 将解析后的用户信息附加到客户端对象上，方便后续使用
      client.data.user = payload; // 存储在 socket.data 中（socket.io 推荐方式）
    } catch (error) {
      console.log(error)
      // 处理不同类型的错误
      if (error.name === 'TokenExpiredError') {
        // 令牌过期
        throw new WsException({ message: '令牌已过期', i18nKey: 'error.auth.tokenExpired' });
      } else if (error.name === 'JsonWebTokenError') {
        // 令牌无效（如签名错误、格式错误）
        throw new WsException({ message: '无效的令牌', i18nKey: 'error.auth.invalidToken' });
      } else {
        // 其他错误
        throw new WsException({ message: '令牌验证失败', i18nKey: 'error.auth.verifyFailed' });
      }

    }

    return true; // 验证通过，允许连接
  }

}
