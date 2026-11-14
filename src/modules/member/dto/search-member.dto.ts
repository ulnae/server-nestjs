
import { IsOptional, IsString } from 'class-validator';

export class SearchMemberDto {
    /**
     * 用户id
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
}
