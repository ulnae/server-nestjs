import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from '@/modules/user/entities/user.entity';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
  ) {
    super({
      // 从请求头的 Authorization: Bearer <token> 中提取 Token
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false, // 不忽略过期时间（由 Passport 自动验证）
      secretOrKey: configService.get('JWT_SECRET'), // 验证密钥（与生成 Token 时一致）
    });
  }

  // 验证成功后，将 Token 中的 payload 解析为用户信息（供后续接口使用）
  async validate(payload: any) {
    // 只验签是不够的：JWT 是自包含的，账号被注销/软删后签名依旧合法，
    // 旧 token 还能继续用满整个有效期。这里补一次主键查询（走索引，成本很低）。
    const user = await this.userRepository.findOne({
      where: { id: payload.id },
      select: ['id', 'username', 'isDeleted'],
    });
    if (!user || user.isDeleted) {
      throw new UnauthorizedException('账号已失效，请重新登录');
    }
    return { id: user.id, username: user.username };
  }
}
