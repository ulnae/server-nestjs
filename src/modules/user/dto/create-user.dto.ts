import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateUserDto {

    @IsNotEmpty({ message: '用户名不能为空' })
    @IsString()
    username: string;

    @IsNotEmpty({ message: '密码不能为空' })
    @IsString()
    password: string;

    @IsNotEmpty({ message: '邮箱不能为空' })
    @IsString()
    email: string;

    @IsNotEmpty({ message: '验证码不能为空' })
    @IsString()
    captcha: string;

    // 仅 worker 后端使用（captchaId 关联落库答案），nest 忽略；前端会一起带上
    @IsOptional()
    @IsString()
    captchaId?: string;

}
