import "server-only";
import { createEmailClient, getNotificationEmailSender } from "@/lib/email/client";

export type NotificationEmail = {
  deliveryId: string;
  recipient: string;
  title: string;
  summary: string;
  priority: "critical" | "high" | "normal";
};

export type NotificationEmailProvider = {
  send(message: NotificationEmail): Promise<{ messageId: string }>;
};

/** Sends only concise, curated notification metadata. No evidence, source text, or repository data is accepted. */
export function createResendNotificationProvider(): NotificationEmailProvider {
  const resend = createEmailClient();
  const from = getNotificationEmailSender();
  return {
    async send(message) {
      const result = await resend.emails.send(
        {
          from,
          to: message.recipient,
          subject: `Auterim: ${message.title}`,
          text: `${message.summary}\n\nReview this update in Auterim.`,
        },
        { idempotencyKey: `auterim-notification-${message.deliveryId}` },
      );
      if (result.error) {
        throw Object.assign(new Error("email_provider_rejected"), {
          statusCode: result.error.statusCode ?? 0,
        });
      }
      if (!result.data?.id) throw new Error("email_provider_rejected");
      return { messageId: result.data.id };
    },
  };
}

export function classifyEmailFailure(error: unknown) {
  const statusCode =
    error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : 0;
  if (statusCode === 429) return { category: "provider_rate_limited", transient: true } as const;
  if (statusCode >= 500) return { category: "provider_unavailable", transient: true } as const;
  if (error instanceof TypeError) return { category: "network_error", transient: true } as const;
  return { category: "provider_rejected", transient: false } as const;
}
