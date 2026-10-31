import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { Types } from 'mongoose';
import { validateDestinationUrl } from '@hookpilot/shared';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { getRedisClient } from '../config/redis.js';
import { AlertChannelModel } from '../models/AlertChannel.js';
import { MembershipModel } from '../models/Membership.js';
import { decryptSecret } from '../utils/crypto.js';

export interface AlertMessagePayload {
  workspaceId: string;
  channelId: string;
  kind: 'firing' | 'resolved' | 'summary' | 'test';
  ruleName: string;
  scopeType: string;
  scopeName: string;
  metricValueText: string;
  windowMinutes?: number | undefined;
  count?: number | undefined;
  dashboardLink: string;
  topFailureReasons?: string[] | undefined;
  testMessage?: string | undefined;
}

export interface TransportResult {
  status: 'sent' | 'failed';
  kind: 'firing' | 'resolved' | 'summary' | 'test';
  error?: string | null;
  sentAt: Date;
}

export class AlertTransportService {
  private mailTransporter: Transporter | null = null;

  private getMailTransporter(): Transporter {
    if (!this.mailTransporter) {
      const auth =
        env.SMTP_USER && env.SMTP_PASS ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined;

      this.mailTransporter = nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_PORT === 465,
        auth,
      });
    }
    return this.mailTransporter;
  }

  /**
   * Enforces at most 20 notifications per channel per hour.
   * Folds extra alerts into one summary message.
   */
  async checkRateLimit(channelId: string): Promise<{ allowed: boolean; isSummaryFold: boolean }> {
    try {
      const redis = getRedisClient();
      const currentHour = new Date().toISOString().slice(0, 13); // 'YYYY-MM-DDTHH'
      const key = `alert:channel:rate:${channelId}:${currentHour}`;
      const count = await redis.incr(key);
      if (count === 1) {
        await redis.expire(key, 3600);
      }

      if (count <= 20) {
        return { allowed: true, isSummaryFold: false };
      }
      if (count === 21) {
        // Send exactly one summary message for the hour
        return { allowed: true, isSummaryFold: true };
      }
      return { allowed: false, isSummaryFold: false };
    } catch {
      // In offline/test environments, allow delivery
      return { allowed: true, isSummaryFold: false };
    }
  }

  /**
   * Validates that all recipient emails belong to active members of the workspace.
   */
  async validateRecipientEmails(workspaceId: string, emails: string[]): Promise<void> {
    const memberships = await MembershipModel.find({
      workspaceId: new Types.ObjectId(workspaceId),
    }).populate<{ userId?: { email?: string } | null }>('userId', 'email');

    const memberEmails = new Set(
      memberships
        .map((m) => m.userId?.email?.toLowerCase())
        .filter((email): email is string => Boolean(email)),
    );

    for (const email of emails) {
      if (!memberEmails.has(email.toLowerCase())) {
        throw new Error(
          `Recipient email "${email}" is not a member of workspace "${workspaceId}". HookPilot prevents relaying to non-members.`,
        );
      }
    }
  }

  /**
   * Validates that Slack webhook URL is https, on hooks.slack.com, and passes SSRF checks.
   */
  async validateSlackWebhookUrl(url: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Invalid Slack webhook URL');
    }

    if (parsed.protocol !== 'https:') {
      throw new Error('Slack webhook URL must use HTTPS');
    }

    if (parsed.hostname !== 'hooks.slack.com') {
      throw new Error('Slack webhook URL must be hosted on hooks.slack.com');
    }

    const ssrfValid = await validateDestinationUrl(url);
    if (!ssrfValid) {
      throw new Error('Slack webhook URL rejected by SSRF guard (private/internal address)');
    }
  }

  /**
   * Dispatches a notification to the specified channel.
   * Never throws - returns a TransportResult for AlertHistory recording.
   */
  async send(payload: AlertMessagePayload): Promise<TransportResult> {
    const now = new Date();
    try {
      const channel = await AlertChannelModel.findById(payload.channelId);
      if (!channel) {
        return {
          status: 'failed',
          kind: payload.kind,
          error: 'AlertChannel not found',
          sentAt: now,
        };
      }

      // Check Rate Limit (unless it is a test message)
      let effectiveKind = payload.kind;
      if (payload.kind !== 'test') {
        const { allowed, isSummaryFold } = await this.checkRateLimit(payload.channelId);
        if (!allowed) {
          return {
            status: 'sent',
            kind: 'summary',
            error: null,
            sentAt: now,
          };
        }
        if (isSummaryFold) {
          effectiveKind = 'summary';
        }
      }

      const decryptedConfig = JSON.parse(decryptSecret(channel.configEncrypted));

      if (channel.type === 'email') {
        await this.sendEmail(payload, decryptedConfig, effectiveKind);
      } else if (channel.type === 'slack') {
        await this.sendSlack(payload, decryptedConfig, effectiveKind);
      } else {
        return {
          status: 'failed',
          kind: effectiveKind,
          error: `Unsupported channel type: ${channel.type}`,
          sentAt: now,
        };
      }

      return { status: 'sent', kind: effectiveKind, error: null, sentAt: now };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { channelId: payload.channelId, error: errorMsg },
        'Alert notification delivery failed',
      );
      return { status: 'failed', kind: payload.kind, error: errorMsg, sentAt: now };
    }
  }

  private async sendEmail(
    payload: AlertMessagePayload,
    config: { emails: string[] },
    kind: 'firing' | 'resolved' | 'summary' | 'test',
  ): Promise<void> {
    const recipients = config.emails || [];
    if (recipients.length === 0) {
      throw new Error('No recipient emails configured for email channel');
    }

    // Verify workspace membership for recipients
    await this.validateRecipientEmails(payload.workspaceId, recipients);

    let subject = `[${kind.toUpperCase()}] HookPilot Alert: ${payload.ruleName}`;
    if (kind === 'test') {
      subject = `[TEST] HookPilot Alert Channel Test`;
    } else if (kind === 'resolved') {
      subject = `[RESOLVED] HookPilot Alert: ${payload.ruleName}`;
    } else if (kind === 'summary') {
      subject = `[SUMMARY] Hourly Alert Rate Limit Reached`;
    }

    const textLines = [
      subject,
      '--------------------------------------------------',
      `Rule:   ${payload.ruleName}`,
      `Scope:  ${payload.scopeType} (${payload.scopeName})`,
      `Metric: ${payload.metricValueText}`,
      payload.windowMinutes ? `Window: ${payload.windowMinutes} minutes` : '',
      payload.count !== undefined ? `Count:  ${payload.count}` : '',
      '',
      payload.topFailureReasons && payload.topFailureReasons.length > 0
        ? `Top Failure Reasons:\n${payload.topFailureReasons.map((r, i) => `  ${i + 1}. ${r}`).join('\n')}\n`
        : '',
      payload.testMessage ? `Message: ${payload.testMessage}\n` : '',
      `Dashboard: ${payload.dashboardLink}`,
      '--------------------------------------------------',
      'HookPilot automated alerts. No confidential headers or payload bodies are included.',
    ].filter(Boolean);

    const transporter = this.getMailTransporter();
    await transporter.sendMail({
      from: env.ALERT_FROM,
      to: recipients.join(', '),
      subject,
      text: textLines.join('\n'),
    });
  }

  private async sendSlack(
    payload: AlertMessagePayload,
    config: { webhookUrl: string },
    kind: 'firing' | 'resolved' | 'summary' | 'test',
  ): Promise<void> {
    const webhookUrl = config.webhookUrl;
    await this.validateSlackWebhookUrl(webhookUrl);

    const titleEmoji =
      kind === 'firing' ? '🚨' : kind === 'resolved' ? '✅' : kind === 'test' ? '🧪' : '📊';

    const headerText = `${titleEmoji} *[${kind.toUpperCase()}] ${payload.ruleName}*`;
    const details = [
      `*Scope:* \`${payload.scopeType}:${payload.scopeName}\``,
      `*Metric:* ${payload.metricValueText}`,
      payload.windowMinutes ? `*Window:* ${payload.windowMinutes}m` : null,
      payload.testMessage ? `*Test:* ${payload.testMessage}` : null,
    ]
      .filter(Boolean)
      .join('  |  ');

    const failureSection =
      payload.topFailureReasons && payload.topFailureReasons.length > 0
        ? `\n*Top Failure Reasons:*\n${payload.topFailureReasons.map((r) => `• ${r}`).join('\n')}`
        : '';

    const slackPayload = {
      text: `${headerText}\n${details}${failureSection}\n<${payload.dashboardLink}|View in HookPilot>`,
    };

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(slackPayload),
      redirect: 'manual', // do not follow redirects
      signal: AbortSignal.timeout(5000), // 5s timeout
    });

    if (!res.ok) {
      throw new Error(`Slack webhook responded with HTTP ${res.status}`);
    }
  }
}

export const alertTransportService = new AlertTransportService();
