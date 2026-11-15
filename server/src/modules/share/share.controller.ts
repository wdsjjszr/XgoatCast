import {
  Controller,
  Get,
  Post,
  Query,
  Body,
  UseGuards,
  Req,
  HttpException,
  HttpStatus,
  Logger,
  Optional,
} from '@nestjs/common';
import { ShareTokenGuard } from '../auth/guards/share-token.guard';
import { AgoraService } from '../agora/agora.service';
import { SessionService } from '../session/session.service';
import { AgoraRole } from '../agora/agora.types';
import { DatabaseService } from '../database/database.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { rtcDiagnostic } from './rtc-diagnostic';
import { AgoraUsageService } from '../agora/agora-usage.service';

@Controller('api/share')
export class ShareController {
  private readonly logger = new Logger(ShareController.name);
  private readonly desktopLaunches = new Map<string, { id: string; clientId: string; respondedAt: number }>();

  constructor(
    private readonly agora: AgoraService,
    private readonly sessionService: SessionService,
    private readonly db: DatabaseService,
    private readonly analytics: AnalyticsService,
    @Optional() private readonly usage?: AgoraUsageService,
  ) {}

  @Get('info')
  @UseGuards(ShareTokenGuard)
  info(@Req() req: any, @Query('desktopLaunchId') desktopLaunchId?: string, @Query('desktopClientId') desktopClientId?: string) {
    const now = Date.now();
    for (const [id, response] of this.desktopLaunches) {
      if (now - response.respondedAt > 120_000) this.desktopLaunches.delete(id);
    }
    if (!req.panelViewer && /^[a-zA-Z0-9_-]{16,128}$/.test(desktopLaunchId || '') && /^[a-zA-Z0-9_-]{16,128}$/.test(desktopClientId || '')) {
      this.desktopLaunches.set(req.session.id, { id: desktopLaunchId!, clientId: desktopClientId!, respondedAt: now });
      if (this.desktopLaunches.size > 2000) this.desktopLaunches.delete(this.desktopLaunches.keys().next().value!);
    }
    const info = this.sessionService.toInfo(req.session);
    const serverId = req.session.spaceId || '';
    const allowedQualities = this.agora.getAllowedQualities(serverId);
    return {
      ...info,
      ...(req.panelViewer ? { shareLink: '', publisherClientId: undefined } : {}),
      allowedQualities,
      qualityBitrates: this.db.getGlobalConfig().qualityBitrates,
      desktopLaunch: req.panelViewer ? undefined : this.desktopLaunches.get(req.session.id),
    };
  }

  @Get('token')
  @UseGuards(ShareTokenGuard)
  token(@Req() req: any, @Query('role') role: string, @Query('uid') requestedUid?: string) {
    if (role !== undefined && role !== 'publisher' && role !== 'subscriber') {
      throw new HttpException('invalid RTC role', HttpStatus.BAD_REQUEST);
    }
    const r: AgoraRole = role === 'publisher' ? 'publisher' : 'subscriber';
    const uid = requestedUid === undefined
      ? (r === 'publisher' ? 1 : Math.floor(Math.random() * 99999) + 100)
      : Number(requestedUid);
    if ((requestedUid !== undefined && (typeof requestedUid !== 'string' || !/^[1-9]\d{0,9}$/.test(requestedUid))) ||
        !Number.isInteger(uid) || uid < 1 || uid > 0xffffffff ||
        (r === 'publisher' ? uid !== 1 : uid === 1)) {
      throw new HttpException('invalid RTC uid for role', HttpStatus.BAD_REQUEST);
    }
    const serverId = req.session.spaceId || '';
    const account = this.usage?.prepareToken(req.session.id, r === 'publisher');
    const result = this.agora.generateToken(req.session.channel, uid, r, serverId, account);
    if (!result.appId) {
      this.logger.warn(`token endpoint: appId not configured for serverId=${serverId}`);
      throw new HttpException(
        { message: '该服务器尚未配置 Agora App ID，请联系服务器管理员在管理面板中配置', code: 'AGORA_NOT_CONFIGURED' },
        HttpStatus.BAD_REQUEST,
      );
    }
    if (r === 'publisher') this.usage?.recordTokenIdentity(req.session.id, result.appId);
    return result;
  }

  @Get('preview')
  @UseGuards(ShareTokenGuard)
  preview(@Req() req: any) {
    return { appId: this.usage?.previewAppId(req.session.id) || '' };
  }

  @Post('start')
  @UseGuards(ShareTokenGuard)
  start(
    @Req() req: any,
    @Body('quality') quality?: string,
    @Body('clientId') clientId?: string,
    @Body('lowLatency') lowLatency?: boolean,
    @Body('autoResume') autoResume?: boolean,
  ) {
    if (autoResume !== undefined && typeof autoResume !== 'boolean') throw new HttpException('invalid autoResume', HttpStatus.BAD_REQUEST);
    const serverId = req.session.spaceId || '';
    if (this.db.getServer(serverId)?.platform === 'heychat' && this.db.getServer(serverId)?.agoraAccountPoolEnabled && !req.session.agoraAccountId) {
      throw new HttpException('请先获取发布凭证再开始共享', HttpStatus.CONFLICT);
    }
    const allowedQualities = this.agora.getAllowedQualities(serverId);
    if (!quality || !allowedQualities.includes(quality)) {
      throw new HttpException(
        { message: '该画质未对本服务器开放，请刷新页面后重新选择', code: 'QUALITY_NOT_ALLOWED' },
        HttpStatus.BAD_REQUEST,
      );
    }
    const session = this.sessionService.startSharing(
      req.session.token,
      clientId,
      lowLatency,
      autoResume,
    );
    if (session) {
      this.sessionService.updateQuality(session.id, quality);
    }
    if (!session) {
      return { ok: false, message: 'unable to start sharing (session ended or publisher locked)' };
    }
    return { ok: true };
  }

  @Post('stop')
  @UseGuards(ShareTokenGuard)
  stop(@Req() req: any) {
    const session = this.sessionService.stopSharing(req.session.token);
    if (session) this.logger.log(JSON.stringify({ eventType: 'share_stopped', sessionId: session.id, role: 'publisher' }));
    return { ok: !!session };
  }

  @Post('end')
  @UseGuards(ShareTokenGuard)
  end(@Req() req: any) {
    this.sessionService.endSession(req.session.id, 'publisher_ended');
    return { ok: true };
  }

  /** Desktop capture owns its heartbeat independently from the browser control page. */
  @Post('heartbeat')
  @UseGuards(ShareTokenGuard)
  heartbeat(@Req() req: any, @Body('clientId') clientId?: string) {
    if (!clientId || req.session.publisherClientId !== clientId ||
        !(['active', 'auto_paused'].includes(req.session.status) ||
          (req.session.status === 'grace' && req.session.graceReason === 'heartbeat'))) {
      return { ok: false };
    }
    return { ok: this.sessionService.heartbeat(req.session.token) };
  }

  @Post('telemetry')
  @UseGuards(ShareTokenGuard)
  telemetry(@Req() req: any, @Body() body: any) {
    if (body?.eventType === 'rtc_state') {
      if (!req.panelViewer || body.role === 'subscriber') this.usage?.report(req.session.id, body);
      return { ok: true };
    }
    if (body?.eventType === 'rtc_diagnostic') {
      const diagnostic = rtcDiagnostic(req.session.id, body);
      if (!diagnostic || (req.panelViewer && diagnostic.role === 'publisher')) {
        throw new HttpException('invalid RTC diagnostic', HttpStatus.BAD_REQUEST);
      }
      this.logger.log(JSON.stringify(diagnostic));
      this.usage?.report(req.session.id, body);
      return { ok: true };
    }
    this.analytics.recordClientTelemetry(req.session, {
      pageType: body?.pageType,
      eventType: body?.eventType,
      failureReason: body?.failureReason,
      deviceType: body?.deviceType,
      osName: body?.osName,
      browserName: body?.browserName,
      browserMajor: body?.browserMajor,
    });
    return { ok: true };
  }
}
