import { PartialType } from '@nestjs/swagger';
import { CreateApplyDto } from './create-apply.dto';
import { IsNotEmpty, IsOptional } from 'class-validator';

export class UpdateApplyDto extends PartialType(CreateApplyDto) {
     /**
      * 申请状态
      */
    @IsNotEmpty({ message: '申请状态不能为空' })
    status: boolean;

    /**
     * 处理状态（服务端会自己置为 true，客户端不必传）
      */
    @IsOptional()
    handle_status?: boolean;
}
