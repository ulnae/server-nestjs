import { IsOptional, IsString } from 'class-validator';

/**
 * 更新用户：一次可改用户名 / 邮箱 / 密码。
 * 刻意不从 CreateUserDto 派生，避免 captcha 成为可更新字段。
 *
 * oldPassword：改密码或邮箱时必填，服务端校验身份，防止持有 token 即可裸改。
 */
export class UpdateUserDto {
    @IsOptional()
    @IsString()
    username?: string;

    @IsOptional()
    @IsString()
    email?: string;

    @IsOptional()
    @IsString()
    password?: string;

    @IsOptional()
    @IsString()
    oldPassword?: string;
}
