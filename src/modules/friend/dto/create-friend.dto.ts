import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateFriendDto {
    /**
     * 好友ID
     */
    @IsNotEmpty({ message: '好友ID不能为空' })
    @IsString({ message: '好友ID必须是字符串' })
    friend_id: string;

    /**
     * 创建人 —— 仅为兼容旧客户端保留，服务端一律取 token 里的用户
     */
    @IsOptional()
    @IsString()
    creator?: string;
}
