import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtStrategy } from '@/modules/auth/strategies/jwt.strategy';
import { UserEntity } from '@/modules/user/entities/user.entity';

@Module({
    imports: [PassportModule, TypeOrmModule.forFeature([UserEntity])],
    providers: [JwtStrategy], // 注册 JWT 策略
    exports: [JwtStrategy],
})
export class AuthModule {

}
