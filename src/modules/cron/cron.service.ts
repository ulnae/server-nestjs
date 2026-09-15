import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SocketGateway } from '@/socket/socket.gateway';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class CronService {
  private readonly logger = new Logger(CronService.name);
  private readonly publicDir = path.join(process.cwd(), 'public');

  constructor(private readonly socketGateway: SocketGateway) {
    this.logger.log('CronService initialized');
  }

  /**
   * 每日凌晨清空public目录下的所有文件夹
   * 使用CronExpression.CRON_DAILY表示每天凌晨执行
   */
  @Cron(CronExpression.EVERY_WEEKEND)
  async cleanPublicDirectory() {
    this.logger.log('开始执行定时任务: 清空public目录');

    try {
      // 检查public目录是否存在
      if (!fs.existsSync(this.publicDir)) {
        this.logger.warn(`public目录不存在: ${this.publicDir}`);
        return;
      }

      // 读取public目录下的所有内容
      const items = fs.readdirSync(this.publicDir);
      let deletedCount = 0;

      for (const item of items) {
        const itemPath = path.join(this.publicDir, item);
        const stats = fs.statSync(itemPath);

        // 只删除文件夹,保留文件
        if (stats.isDirectory()) {
          try {
            // 递归删除文件夹及其内容
            fs.rmSync(itemPath, { recursive: true, force: true });
            deletedCount++;
            this.logger.log(`已删除文件夹: ${item}`);
          } catch (error) {
            this.logger.error(`删除文件夹失败: ${item}`, error.message);
          }
        }
      }

      this.logger.log(`定时任务执行完成,共删除 ${deletedCount} 个文件夹`);
    } catch (error) {
      this.logger.error('执行定时任务时发生错误', error.stack);
    }
  }

  /**
   * 手动触发清空public目录的方法(用于测试)
   */
  async cleanPublicDirectoryManually() {
    this.logger.log('手动触发清空public目录任务');
    await this.cleanPublicDirectory();
  }

  @Cron(CronExpression.EVERY_HOUR)
  handleHourlyTask() {
    try {
      this.logger.log(`每小时的任务执行了！`);
      // 在这里编写你的业务逻辑
      this.socketGateway.wss.emit('system:alert', {
        message: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
        sender: '整点播报',
        timestamp: Date.now()
      });
    } catch (error) {
      this.logger.error('处理每小时任务时发生错误', error.stack);
    }
  }

  // 使用 Cron 表达式：每个工作日（周一至周五）的12、18执行
  @Cron('0 12 * * 1-5')
  handleNoonOffWork() {
    this.handleOffWork('中午 12 点');
  }
  @Cron('0 18 * * 1-5')
  handleEveningOffWork() {
    this.handleOffWork('晚上 6 点');
  }

  private handleOffWork(time: string) {
    try {
      this.logger.log(`工作日${time}的任务执行了！`);
      // 在这里编写你的业务逻辑
      this.socketGateway.wss.emit('system:alert', {
        message: '关电脑，撤！',
        sender: '下班提醒',
        timestamp: Date.now()
      });
    } catch (error) {
      this.logger.error('处理下班提醒时发生错误', error.stack);
    }
  }

  // 使用 Cron 表达式：每个工作日（周一至周五）的8.30、13.30执行
  @Cron('0 30 8 * * 1-5')
  handleMorningGoToWork() {
    this.handleGoToWork('早上 8 点 30 分');
  }
  @Cron('0 30 13 * * 1-5')
  handleAfternoonGoToWork() {
    this.handleGoToWork('下午 1 点 30 分');
  }

  private handleGoToWork(time: string) {
    try {
      this.logger.log(`工作日${time}的任务执行了！`);
      // 在这里编写你的业务逻辑
      this.socketGateway.wss.emit('system:alert', {
        message: '开电脑，干！',
        sender: '上班提醒',
        timestamp: Date.now()
      });
    } catch (error) {
      this.logger.error('处理上班提醒时发生错误', error.stack);
    }
  }
}