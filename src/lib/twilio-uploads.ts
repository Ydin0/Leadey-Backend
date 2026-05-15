// Twilio Supporting Document file uploads.
//
// The standard helper `client.numbers.v2.regulatoryCompliance.supportingDocuments.create()`
// only creates the metadata record — it does NOT upload the actual file. To
// attach the file (required for Twilio's compliance reviewers to actually
// see it), the request has to be multipart/form-data against
// numbers-upload.twilio.com.
//
// Twilio docs:
//   https://www.twilio.com/docs/phone-numbers/regulatory/api/supporting-documents
//   (see "Create a Supporting Document with file upload")
//
// Returns the created SupportingDocument resource shape, same as the
// standard create endpoint.

export interface UploadSupportingDocumentInput {
  fileBuffer: Buffer;
  fileName: string;
  mimeType: string;
  friendlyName: string;
  type: string;
  attributes: Record<string, unknown>;
}

export interface TwilioSupportingDocument {
  sid: string;
  account_sid: string;
  friendly_name: string;
  mime_type: string;
  status: string;
  type: string;
  attributes: Record<string, unknown>;
  date_created: string;
  date_updated: string;
  url: string;
}

export async function uploadSupportingDocumentWithFile(
  input: UploadSupportingDocumentInput,
): Promise<TwilioSupportingDocument> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set");
  }

  const form = new FormData();
  form.append("FriendlyName", input.friendlyName);
  form.append("Type", input.type);
  form.append("Attributes", JSON.stringify(input.attributes));

  // Node's undici Blob — second arg is the filename
  const blob = new Blob([new Uint8Array(input.fileBuffer)], { type: input.mimeType });
  form.append("File", blob, input.fileName);

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const res = await fetch(
    "https://numbers-upload.twilio.com/v2/RegulatoryCompliance/SupportingDocuments",
    {
      method: "POST",
      headers: { Authorization: `Basic ${auth}` },
      body: form,
    },
  );

  const body: any = await res.json().catch(() => null);
  if (!res.ok) {
    const message = body?.message || body?.detail || `Twilio upload failed (${res.status})`;
    const code = body?.code;
    throw new Error(`${message}${code ? ` [${code}]` : ""}`);
  }
  return body as TwilioSupportingDocument;
}

/**
 * Update the attributes on an existing supporting document. Used at submit
 * time to fill in fields the customer didn't provide at upload time (e.g.
 * linking address_sids to a utility bill once we know the Address SID).
 */
export async function updateSupportingDocumentAttributes(
  documentSid: string,
  attributes: Record<string, unknown>,
): Promise<void> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set");
  }

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const params = new URLSearchParams({ Attributes: JSON.stringify(attributes) });
  const res = await fetch(
    `https://numbers.twilio.com/v2/RegulatoryCompliance/SupportingDocuments/${documentSid}`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    },
  );

  if (!res.ok) {
    const body: any = await res.json().catch(() => null);
    throw new Error(body?.message || `Twilio doc-update failed (${res.status})`);
  }
}

/**
 * Create a business end-user via raw fetch so attribute values keep their
 * native JSON types. The Twilio Node SDK stringifies values inside the
 * Attributes payload — that's a problem for is_subassigned, which the
 * evaluator only recognises as a JSON boolean. Sending a bare false here
 * preserves it through the wire.
 */
export interface CreateBusinessEndUserInput {
  friendlyName: string;
  attributes: Record<string, unknown>;
}

export interface TwilioEndUser {
  sid: string;
  account_sid: string;
  friendly_name: string;
  type: string;
  attributes: Record<string, unknown>;
}

export async function createBusinessEndUserRaw(
  input: CreateBusinessEndUserInput,
): Promise<TwilioEndUser> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    throw new Error("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be set");
  }

  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const params = new URLSearchParams({
    FriendlyName: input.friendlyName,
    Type: "business",
    Attributes: JSON.stringify(input.attributes),
  });
  const res = await fetch(
    `https://numbers.twilio.com/v2/RegulatoryCompliance/EndUsers`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    },
  );

  const body: any = await res.json().catch(() => null);
  if (!res.ok) {
    const message = body?.message || `Twilio EndUser create failed (${res.status})`;
    const code = body?.code ? ` [${body.code}]` : "";
    throw new Error(`${message}${code}`);
  }
  return body as TwilioEndUser;
}
