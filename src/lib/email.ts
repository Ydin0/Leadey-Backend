import { Resend } from "resend";

let _resend: Resend | null = null;
function getResend(): Resend {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error("RESEND_API_KEY is not set");
  _resend = new Resend(key);
  return _resend;
}

const DEFAULT_FROM = "Leadey <hello@mail.leadey.ai>";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  /** Optional override of the From header */
  from?: string;
  /** File attachments (e.g. a calendar .ics invite). */
  attachments?: { filename: string; content: string | Buffer; contentType?: string }[];
}

export interface SendEmailResult {
  id: string;
}

/**
 * Sends an email via Resend. Throws on failure. The Resend SDK throws if the
 * domain isn't verified or the API key is invalid — callers should catch.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const from = input.from || process.env.EMAIL_FROM || DEFAULT_FROM;
  const resend = getResend();

  const result = await resend.emails.send({
    from,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
    replyTo: input.replyTo,
    ...(input.attachments?.length
      ? {
          attachments: input.attachments.map((a) => ({
            filename: a.filename,
            content: typeof a.content === "string" ? Buffer.from(a.content).toString("base64") : a.content.toString("base64"),
            contentType: a.contentType,
          })),
        }
      : {}),
  });

  if (result.error) {
    throw new Error(`Resend error: ${result.error.message}`);
  }
  if (!result.data?.id) {
    throw new Error("Resend returned no email id");
  }
  return { id: result.data.id };
}
