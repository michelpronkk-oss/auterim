import "server-only";
import { Resend } from "resend";
import { getEnvironment } from "@/lib/env/schema";

/** Create the mail client on demand. This module never sends email by itself. */
export function createEmailClient() {
  const apiKey = getEnvironment().RESEND_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Resend is not configured. Add RESEND_API_KEY to .env.local before using email features.",
    );
  }

  return new Resend(apiKey);
}

export function getNotificationEmailSender() {
  const sender = getEnvironment().RESEND_FROM_EMAIL;
  if (!sender) throw new Error("resend_sender_not_configured");
  return sender;
}
