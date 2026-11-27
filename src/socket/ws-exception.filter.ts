import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { Socket } from 'socket.io';
import { Event } from '@/socket/events';

/**
 * 网关异常过滤器 —— 让 WebSocket 侧也有和 worker 一致的 `exception` 回执。
 *
 * 之前网关没有任何 try/catch：处理器里抛错只会落到 Nest 默认的 WS 异常过滤器，
 * 发出 `{ status, message }` 这种和契约不一致的形状，前端拿到后也分不清是哪条消息失败。
 */
@Catch()
export class WsExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('WsExceptionFilter');

  catch(exception: any, host: ArgumentsHost): void {
    const client = host.switchToWs().getClient<Socket>();
    const pattern = host.switchToWs().getPattern?.();

    // i18n：WsException 支持对象形式 { message, i18nKey, i18nParams }，把 key 一并带给前端
    let message = '操作失败，请稍后重试';
    let i18nKey = 'error.common.retryLater';
    let i18nParams: Record<string, any> | undefined;
    const response = exception?.getResponse?.();
    if (typeof response === 'string') {
      message = response;
    } else if (response && typeof response === 'object') {
      if (typeof response.message === 'string') message = response.message;
      else if (Array.isArray(response?.message)) message = response.message.join('；');
      if (typeof response.i18nKey === 'string') i18nKey = response.i18nKey;
      if (response.i18nParams !== undefined) i18nParams = response.i18nParams;
    } else if (exception && typeof exception.message === 'string' && exception.message) {
      message = exception.message;
    }

    this.logger.warn(`[ws] ${String(pattern)} failed: ${message}`);

    try {
      client.emit(Event.EXCEPTION, {
        event: pattern,
        message,
        i18nKey,
        ...(i18nParams ? { i18nParams } : {}),
        timestamp: Date.now(),
      });
    } catch {
      /* 连接已断开，忽略 */
    }
  }
}
