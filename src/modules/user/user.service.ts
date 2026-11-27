import { Injectable, HttpException } from '@nestjs/common';
import { CreateUserDto } from '@/modules/user/dto/create-user.dto';
import { UpdateUserDto } from '@/modules/user/dto/update-user.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Like, Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { ConfigService } from '@nestjs/config';
import { UserRo, UserInfo } from '@/modules/user/user.interface';


import { UserEntity } from '@/modules/user/entities/user.entity';



@Injectable()
export class UserService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    private jwtService: JwtService, // 注入 JWT 服务
    private configService: ConfigService, // 注入配置服务
    
  ) { }

  /**
   * 唯一性检查。命中就抛 409（冲突）。
   * 之前这里抛 401，被前端 axios 拦截器当成「登录失效」直接登出；
   * 外层的 try/catch 又会把所有异常重写成 401，等于把状态码彻底吞掉。
   */
  async findeByWhere(where: object, errMsg: string | object, excludeId?: string) {
    const queryUser = await this.userRepository.findOne({ where: { ...where } });
    if (queryUser && queryUser.id !== excludeId) {
      throw new HttpException(errMsg, 409);
    }
  }

  async create(createUserDto: CreateUserDto): Promise<string> {
    await this.findeByWhere({ username: createUserDto.username }, {
      message: '用户名已存在', i18nKey: 'error.user.usernameTaken',
    });
    await this.findeByWhere({ email: createUserDto.email }, {
      message: '邮箱已被注册', i18nKey: 'error.user.emailTaken',
    });

    // 显式挑字段：captcha 只用于校验，不能跟着 save 落库
    await this.userRepository.save({
      username: createUserDto.username,
      email: createUserDto.email,
      password: await bcrypt.hash(createUserDto.password, 8),
    });
    return '创建用户成功'

  }

  async findAll(page: number = 1, pageSize: number = 10): Promise<UserRo> {
    const [rows, total] = await this.userRepository.findAndCount({
      skip: (page - 1) * pageSize, // 分页偏移量
      take: pageSize, // 每页显示的记录数
      order: { createdAt: 'DESC' },
      where: { isDeleted: false },
      select: ['username', 'id', 'email', 'createdAt', 'updatedAt']
    });

    return {
      rows,
      total,
    };
  }

  async searchAll(username: string) {
    return this.userRepository.find({
      where:{
        username: Like(`%${username}%`),
        isDeleted: false
      },
      order: { createdAt: 'DESC' },
      select: ['username', 'id', 'email', 'createdAt', 'updatedAt']
    })
  }

  async findOne(id: string): Promise<UserInfo> {
    const userInfo = await this.userRepository.findOne({ where: { id, isDeleted: false }, select: ['username', 'id', 'email', 'createdAt', 'updatedAt'] })
    if (!userInfo) {
      throw new HttpException({ message: '该用户不存在', i18nKey: 'error.user.notFound' }, 404);
    }
    return userInfo
  }

  async update(id: string, updateUserDto: UpdateUserDto, user: UserInfo) {
    const existUser = await this.userRepository.findOne({ where: { id, isDeleted: false } });
    if (!existUser) {
      throw new HttpException({ message: `id为${id}的用户不存在`, i18nKey: 'error.user.notFoundId', i18nParams: { id } }, 404);
    }

    if (user.id !== id) {
      throw new HttpException({ message: '您没有权限更新该用户', i18nKey: 'error.user.noUpdatePermission' }, 403);
    }

    /* 一次更新用户名 / 邮箱 / 密码。
       改密码或邮箱时必须带原密码（oldPassword）确认身份，避免持有 token 即可裸改。 */
    const oldPassword = String(updateUserDto.oldPassword || '');
    const password = updateUserDto.password ? String(updateUserDto.password) : '';
    const email = updateUserDto.email ? String(updateUserDto.email).trim() : '';
    const wantPassword = !!password;
    const wantEmail = !!email && email !== existUser.email;
    if (wantPassword || wantEmail) {
      if (!oldPassword || !(await bcrypt.compare(oldPassword, existUser.password))) {
        throw new HttpException({ message: '原密码错误', i18nKey: 'error.user.oldPassWrong' }, 400);
      }
    }

    const updatePost: any = {};
    if (updateUserDto.username && updateUserDto.username !== existUser.username) {
      await this.findeByWhere({ username: updateUserDto.username }, '用户名已存在', id);
      updatePost.username = updateUserDto.username;
    }
    if (wantEmail) {
      await this.findeByWhere({ email }, '邮箱已被注册', id);
      updatePost.email = email;
    }
    if (wantPassword) {
      if (password.length < 6 || password.length > 32) {
        throw new HttpException({ message: '密码长度需为 6-32 位', i18nKey: 'error.user.passLenInvalid' }, 400);
      }
      updatePost.password = await bcrypt.hash(password, 8);
    }

    const merged = this.userRepository.merge(existUser, updatePost);
    await this.userRepository.save(merged);
    return '更新用户成功'
  }

  async remove(id: string, operatorId?: string) {
    const existUser = await this.userRepository.findOne({ where: { id, isDeleted: false } });
    if (!existUser) {
      throw new HttpException({ message: `id为${id}的用户不存在`, i18nKey: 'error.user.notFoundId', i18nParams: { id } }, 404);
    }
    // 只能注销自己：否则任何登录用户都能把别人的账号软删掉
    if (!operatorId || operatorId !== id) {
      throw new HttpException({ message: '您没有权限删除该用户', i18nKey: 'error.user.noDeletePermission' }, 403);
    }
    existUser.isDeleted = true;
    await this.userRepository.save(existUser);
    return '删除用户成功'
  }


  /**
   * 验证用户并生成 Token
   * @param username 用户名
   * @param password 密码
   */
  async login(username: string, password: string) {
    // 1. 查询用户是否存在
    const user = await this.userRepository.findOne({ where: { username, isDeleted: false } });
    if (!user) {
      throw new HttpException({ message: '用户名或密码错误', i18nKey: 'error.user.userOrPassWrong' }, 401);
    }

    // 2. 验证密码（假设密码在数据库中是加密存储的）
    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      throw new HttpException({ message: '用户名或密码错误', i18nKey: 'error.user.userOrPassWrong' }, 401);
    }

    
    // 4. 生成并返回 Token
    return Object.assign(user,{
      // 3. 生成 JWT  payload（存储用户关键信息，避免敏感数据）
      access_token: this.jwtService.sign({ id: user.id, username: user.username }), // 生成 Token
      token_type: 'Bearer',
      expires_in: this.configService.get('JWT_EXPIRES_IN'), // 与 JWT 配置的过期时间一致（秒）
      password: undefined,
      isDeleted: undefined,
    });

  }

}
