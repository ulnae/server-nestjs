import { NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';
import { HttpExceptionFilter } from '@/common/filter/http-exception/http-exception.filter';
import { TransformInterceptor } from '@/common/interceptor/transform/transform.interceptor';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import { LoggerService } from '@/logger/logger.service';
import session from 'express-session';

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



  // 启用 CORS（允许所有域）
  app.enableCors({
    // origin: ['http://localhost', 'http://192.168.58.190'], // 允许的来源（credentials: true 时不能使用通配符）
    // origin: ['http://localhost', 'http://62.234.18.27'], // 允许的来源（credentials: true 时不能使用通配符）
    origin:(origin, callback) => {
      // 在此处加入你的判断逻辑
      callback(null, origin);
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE', // 允许的 HTTP 方法
    allowedHeaders: ['Content-Type', 'Authorization'], // 允许的请求头
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
