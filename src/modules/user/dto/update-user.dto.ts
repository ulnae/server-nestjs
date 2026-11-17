import { IsOptional, IsString } from 'class-validator';

/**
 * 更新用户。刻意不从 CreateUserDto 派生：否则 captcha 也会成为可更新字段，
 * whitelist 放行后会被 merge 进实体（虽然目前实体会忽略未知列，但语义上是错的）。
 */
export class UpdateUserDto {
    @IsOptional()
    @IsString()
    username?: string;

    @IsOptional()
    @IsString()
    password?: string;

    @IsOptional()
    @IsString()
    email?: string;
}
