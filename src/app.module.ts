import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerService } from '@/logger/logger.service';
import { AlertController } from '@/modules/alert/alert.controller';
import { UserModule } from '@/modules/user/user.module';
import { UserEntity } from '@/modules/user/entities/user.entity';
import { AuthModule } from '@/modules/auth/auth.module';
import { RoomModule } from '@/modules/room/room.module';
import { RoomEntity } from '@/modules/room/entities/room.entity';
import { CaptchaModule } from '@/modules/captcha/captcha.module';
import { MemberModule } from '@/modules/member/member.module';
import { MemberEntity } from '@/modules/member/entities/member.entity';
import { ApplyModule } from '@/modules/apply/apply.module';
import { ApplyEntity } from '@/modules/apply/entities/apply.entity';
import { FriendModule } from '@/modules/friend/friend.module';
import { FriendEntity } from '@/modules/friend/entities/friend.entity';
import { CronModule } from '@/modules/cron/cron.module';
import { SocketModule } from '@/socket/socket.module';
import envConfig from '../config/env';
@Module({
  imports: [
    ScheduleModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true, // 设置为全局
      envFilePath: [envConfig.path],
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (configService: ConfigService) => ({
        type: 'mysql', // 数据库类型
        entities: [UserEntity, RoomEntity, MemberEntity, ApplyEntity, FriendEntity], // 数据表实体，synchronize为true时，自动创建表，生产环境建议关闭
        host: configService.get('DB_HOST'), // 主机，默认为localhost
        port: configService.get<number>('DB_PORT'), // 端口号
        username: configService.get('DB_USER'), // 用户名
        password: configService.get('DB_PASSWD'), // 密码
        database: configService.get('DB_DATABASE'), //数据库名
        timezone: '+08:00', //服务器上配置的时区
        synchronize: true, //根据实体自动创建数据库表， 生产环境建议关闭
        // logging: true, // 开启打印生成sql语句
      }),
    }),
    PassportModule,
    // 配置 JWT 模块
    JwtModule.registerAsync({
      global: true, // 关键：设置为全局模块
      useFactory: (configService: ConfigService) => ({
        secret: configService.get('JWT_SECRET'), // 从环境变量取密钥
        signOptions: {
          expiresIn: configService.get('JWT_EXPIRES_IN'), // 过期时间
        },
      }),
      inject: [ConfigService], // 注入 ConfigService 用于读取环境变量
    }),
    AuthModule,
    UserModule,
    RoomModule,
    CaptchaModule,
    MemberModule,
    ApplyModule,
    FriendModule,
    CronModule,
    SocketModule
  ],
  controllers: [AlertController],
  providers: [LoggerService],
})
export class AppModule { }
