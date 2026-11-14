import { NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';
import { HttpExceptionFilter } from '@/common/filter/http-exception/http-exception.filter';
import { TransformInterceptor } from '@/common/interceptor/transform/transform.interceptor';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { LoggerService } from '@/logger/logger.service';
import session from 'express-session';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const config = app.get(ConfigService);
  // 设置 api 访问前缀
  app.setGlobalPrefix(config.get('PREFIX') as string);

  // 注册全局 logger 拦截器
  const loggerService = app.get(LoggerService);
  // 注册全局错误的过滤器
  app.useGlobalFilters(new HttpExceptionFilter(loggerService));
  // 全局注册拦截器
  app.useGlobalInterceptors(new TransformInterceptor(loggerService))

  /* 全局参数校验：whitelist 会剔除 DTO 未声明的字段。
     之前任何 PATCH 都能把 body 里的 user_id / room_id 一起写进实体（mass assignment），
     现在只有 DTO 声明过的字段能进入业务层。 */
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    transform: true,
  }));

  // 设置swagger文档
  const swaggerOptions = new DocumentBuilder()
    .setTitle('NestJS 管理后台')
    .setDescription('NestJS 管理后台接口文档')
    .setVersion('1.0')
    .addBearerAuth({
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        in: 'header', // 认证信息放置的位置
        name: 'Authorization', // 显式指定请求头名称
        description: '请在请求头中携带 JWT 令牌，格式：Bearer <token>',
      },
      'Authorization',
    )
    .build();
  const document = SwaggerModule.createDocument(app, swaggerOptions);
  SwaggerModule.setup('docs', app, document,  {
    swaggerOptions: {
      persistAuthorization: true,
    },
    customSiteTitle: 'Server-Nest API Docs',
  });
  

  // 支持静态资源
  app.useStaticAssets('public', { prefix: '/public' });



  /* CORS：只放行 ALLOW_ORIGIN 里列出的来源（逗号分隔）。
     之前是 origin 回调无条件回声任意 Origin，且 credentials: true，
     等于任何站点都能带着 session cookie 读接口返回。 */
  const allowOrigins = String(config.get('ALLOW_ORIGIN') || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  app.enableCors({
    origin: allowOrigins.length ? allowOrigins : false,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE', // 允许的 HTTP 方法
    allowedHeaders: ['Content-Type', 'Authorization', 'x-alert-secret'], // 允许的请求头
    credentials: true, // 是否允许携带凭证（如 Cookie）
    maxAge: 3600, // 预检请求的有效期（单位：秒）
  });

  // 配置 session
  app.use(
    session({
      name: config.get('SESSION_NAME'),  // 自定义名称，不暴露技术栈
      secret: config.get('SESSION_SECRET') as string, // 用于签名 session ID 的密钥
      resave: false,
      saveUninitialized: false,
      cookie: {
          httpOnly: false,     // 防止 XSS
          secure: false,       // 仅 HTTPS
          sameSite: 'strict', // 防止 CSRF
          // domain: '.example.com',
          path: '/',
          maxAge: 1000 * 60 * 60 * 24 * 7 // 7天
      },
      // store: new RedisStore({ // 不用默认的内存存储
      //     host: 'localhost',
      //     port: 6379
      // })
    }),
  );

  await app.listen(config.get('PORT') as number);
}
bootstrap();
