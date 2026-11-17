import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * 登录入参。
 *
 * 之前 login 直接复用 CreateUserDto：里面 email 是 @IsNotEmpty，
 * 开启全局 ValidationPipe 之后，登录请求（用户名/密码/验证码）会被判成「邮箱不能为空」。
 * 登录与注册的字段本来就不同，必须分开定义。
 */
export class LoginUserDto {
    @IsNotEmpty({ message: '用户名不能为空' })
    @IsString()
    username: string;

    @IsNotEmpty({ message: '密码不能为空' })
    @IsString()
    password: string;

    // 验证码：nest 侧比对 session 里的答案，worker 侧用 captchaId 关联
    @IsNotEmpty({ message: '验证码不能为空' })
    @IsString()
    captcha: string;

    // 仅 worker 后端使用，nest 忽略；前端会一起带上
    @IsOptional()
    @IsString()
    captchaId?: string;
}
