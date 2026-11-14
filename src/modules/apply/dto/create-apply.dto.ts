
import { IsOptional, IsString } from 'class-validator';

export class CreateApplyDto {

    /**
     * 申请人 id
     * 兼容旧字段：服务端一律以 token 为准，这里不再强制要求
     */
    @IsOptional()
    @IsString()
    user_id?: string;

    /**
     * 房间id
     */
    @IsOptional()
    @IsString()
    room_id?: string;

    /**
     * 被申请用户id
     */
    @IsOptional()
    @IsString()
    apply_user_id?: string;
}
