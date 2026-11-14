import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateRoomDto {
    // 房间名称
    @IsNotEmpty({ message: '房间名称不能为空' })
    @IsString()
    name: string;

    // 房间描述（可选，允许空串：群公告可以清空）
    @IsOptional()
    @IsString()
    description?: string;

}
